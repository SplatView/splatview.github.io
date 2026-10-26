import { expect, test, type Locator, type Page } from './backend-test';
import type {} from './alignment-harness';
import { queuePositions } from './queue-fixture';
import { chooseSelectionTool } from './selectTool';

type Snapshot = Awaited<ReturnType<Window['alignmentHarness']['snapshot']>>;
type Activation = { type: string; trusted: boolean; prevented: boolean; button: number };
type Probe = { events: Activation[]; targetEvents: string[]; stop(): void };
declare global { interface Window { alignmentMenuPressProbe?: Probe } }

const tools = (page: Page) => page.getByRole('complementary', { name: 'Tools', exact: true });
const trigger = (page: Page) => tools(page).getByRole('button', { name: 'Alignment', exact: true });
const menu = (page: Page) => page.getByRole('menu', { name: 'Alignment actions', exact: true });
const scene = (page: Page) => page.getByLabel('SplatView scene', { exact: true });
const snapshot = (page: Page) => page.evaluate(() => window.alignmentHarness.snapshot());
async function settled(page: Page) {
  await expect.poll(() => page.evaluate(() => window.alignmentHarness.state())).toMatchObject({ busy: false, alignmentPicking: false, enabled: true });
}
function retained(after: Snapshot, before: Snapshot) {
  for (const key of ['records', 'gpuRecords', 'masks', 'gpuMasks', 'nativeRecordHash', 'gpuRecordHash', 'exported',
    'camera', 'defaultCamera', 'checkpoints', 'background', 'sourceFingerprint', 'deviceEpoch', 'dirty',
    'alignmentTool', 'alignmentPoint', 'alignmentSecondPoint', 'alignmentThirdPoint', 'alignmentNormal', 'alignmentFlip'] as const)
    expect(after[key], key).toEqual(before[key]);
  expect(after.records).toEqual(after.gpuRecords); expect(after.masks).toEqual(after.gpuMasks);
  expect(after.summary.alignment).toEqual(before.summary.alignment);
  expect(after.summary).toMatchObject({ revision: before.summary.revision, contentRevision: before.summary.contentRevision,
    selected: before.summary.selected, visible: before.summary.visible, canUndo: before.summary.canUndo, canRedo: before.summary.canRedo });
  expect(after.work).toEqual({ allocations: 0, bytes: 0 });
}
async function baseline(page: Page) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/e2e/alignment-harness.html');
  await page.waitForFunction(() => window.geometryViewerError || window.alignmentHarness?.ready());
  expect(await page.evaluate(() => window.geometryViewerError)).toBeUndefined();
  await page.evaluate(async () => {
    await window.alignmentHarness.load(); await window.alignmentHarness.seed([2]);
    await window.alignmentHarness.command({ command: 'delete' });
  });
  const deleted = await snapshot(page);
  await page.evaluate(() => window.alignmentHarness.command({ command: 'undo' })); await settled(page);
  await trigger(page).scrollIntoViewIfNeeded(); await page.mouse.move(20, 200);
  const before = await snapshot(page); expect(before.summary.canRedo).toBe(true);
  return { before, deleted };
}
async function open(page: Page) { await trigger(page).click(); await expect(menu(page)).toBeVisible(); }
async function armCenter(page: Page) {
  await open(page); await menu(page).getByRole('menuitemradio', { name: '1-point center', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.alignmentHarness.state())).toMatchObject({ alignmentTool: 'center', alignmentPoint: null });
}
async function contributor(page: Page, id = 0) {
  const pixel = await page.evaluate(id => window.alignmentHarness.pixel(id), id);
  const popup = menu(page);
  if (await popup.count()) {
    const bounds = await popup.boundingBox(); expect(bounds).not.toBeNull();
    expect(pixel.clientX < bounds!.x || pixel.clientX >= bounds!.x + bounds!.width ||
      pixel.clientY < bounds!.y || pixel.clientY >= bounds!.y + bounds!.height).toBe(true);
  }
  await page.mouse.click(pixel.clientX, pixel.clientY);
  return pixel;
}
async function passiveFinish(page: Page) {
  const observed = await page.evaluate(() => window.alignmentHarness.keyboardFinish());
  expect(observed.calls.filter(command => command !== 'summary')).toEqual([]);
  return observed;
}
async function replay(page: Page, deleted: Snapshot) {
  await page.mouse.move(20, 200); await tools(page).getByRole('button', { name: 'Redo', exact: true }).click(); await settled(page);
  const result = await snapshot(page);
  expect(result.records).toEqual(deleted.records); expect(result.masks).toEqual(deleted.masks);
  expect(result.records).toEqual(result.gpuRecords); expect(result.masks).toEqual(result.gpuMasks);
  expect(result.exported).toBe(deleted.exported); return result;
}
async function observe(target: Locator) {
  await target.evaluate(element => {
    window.alignmentMenuPressProbe?.stop();
    const events: Activation[] = [], targetEvents: string[] = [];
    const capture: EventListener = event => {
      if (!(event instanceof MouseEvent)) return;
      events.push({ type: event.type, trusted: event.isTrusted, button: event.button,
        get prevented() { return event.defaultPrevented; } });
    };
    const atTarget = (event: Event) => { targetEvents.push(event.type); };
    const activations = ['click', 'contextmenu', 'auxclick'];
    const types = ['pointerdown', 'mousedown', ...activations];
    for (const type of activations) window.addEventListener(type, capture, true);
    for (const type of types) element.addEventListener(type, atTarget);
    window.alignmentMenuPressProbe = { events, targetEvents, stop() {
      for (const type of activations) window.removeEventListener(type, capture, true);
      for (const type of types) element.removeEventListener(type, atTarget);
    } };
  });
}
const observations = (page: Page) => page.evaluate(() => ({ events: window.alignmentMenuPressProbe!.events,
  targetEvents: window.alignmentMenuPressProbe!.targetEvents }));
test.afterEach(async ({ page }) => { await page.evaluate(() => window.alignmentMenuPressProbe?.stop()); });

test('Alignment hover, directional bridge, click pin and keyboard dismissal preserve native/GPU bytes and executable Redo', async ({ page }, info) => {
  const initial = await baseline(page); await scene(page).focus();
  await page.evaluate(() => window.alignmentHarness.keyboardStart());
  await trigger(page).hover(); await page.waitForTimeout(160);
  await expect(menu(page)).toHaveCount(0); await expect(scene(page)).toBeFocused();
  await expect(menu(page)).toBeVisible(); await expect(scene(page)).toBeFocused();
  const anchor = (await trigger(page).boundingBox())!, popup = (await menu(page).boundingBox())!;
  expect(popup.x + popup.width).toBeLessThan(anchor.x);
  const edge = popup.x + popup.width, gap = anchor.x - edge;
  const y = Math.max(popup.y + 6, Math.min(anchor.y + anchor.height / 2, popup.y + popup.height - 6));
  for (const fraction of [.7, .3]) {
    await page.mouse.move(edge + gap * fraction, y, { steps: 6 }); await page.waitForTimeout(180);
    await expect(menu(page)).toBeVisible();
  }
  await menu(page).getByRole('menuitemradio', { name: '3-point align', exact: true }).hover();
  await page.waitForTimeout(360); await expect(menu(page)).toBeVisible(); await expect(scene(page)).toBeFocused();
  await page.mouse.move(20, 200); await page.waitForTimeout(160); await expect(menu(page)).toBeVisible();
  await expect(menu(page)).toHaveCount(0); await expect(scene(page)).toBeFocused();
  await trigger(page).hover(); await expect(menu(page)).toBeVisible();
  await trigger(page).click(); // Hover-open becomes pinned rather than toggling closed.
  await expect(menu(page).getByRole('menuitemradio', { name: '1-point center', exact: true })).toBeFocused();
  await page.mouse.move(20, 200); await page.waitForTimeout(420); await expect(menu(page)).toBeVisible();
  await trigger(page).click(); await expect(menu(page)).toHaveCount(0);
  await page.waitForTimeout(420); await expect(menu(page)).toHaveCount(0); // Suppressed until pointer leaves.
  await trigger(page).focus(); await page.keyboard.press('ArrowDown'); await expect(menu(page)).toBeVisible();
  // Level floor (alignment.auto) is absent in web-lite, so 3-point align is last.
  await page.keyboard.press('End'); await expect(menu(page).getByRole('menuitemradio', { name: '3-point align', exact: true })).toBeFocused();
  await page.keyboard.press('Escape'); await expect(menu(page)).toHaveCount(0); await expect(trigger(page)).toBeFocused();
  await page.keyboard.press('ArrowDown'); await expect(menu(page)).toBeVisible();
  await page.keyboard.press('Tab'); await expect(menu(page)).toHaveCount(0);
  const observed = await passiveFinish(page); retained(await snapshot(page), initial.before);
  const redone = await replay(page, initial.deleted);
  await info.attach('alignment-passive-popup-native-gpu-history.json', { contentType: 'application/json', body: JSON.stringify({ initial, observed, redone }) });
});

test('Alignment outside canvas dismissal cannot pick a contributor and the next fresh press can confirm a real Center', async ({ page }, info) => {
  await baseline(page); await armCenter(page); const before = await snapshot(page);
  await page.evaluate(() => window.alignmentHarness.keyboardStart()); await open(page);
  await contributor(page); await expect(menu(page)).toHaveCount(0); await settled(page);
  expect((await page.evaluate(() => window.alignmentHarness.state())).alignmentPoint).toBeNull();
  const observed = await passiveFinish(page), dismissed = await snapshot(page); retained(dismissed, before);
  await contributor(page); await expect(page.getByRole('button', { name: 'Set center', exact: true })).toBeEnabled();
  const picked = await snapshot(page), expectedPoint = queuePositions[0].map((value, axis) => Math.fround(axis ? -value : value));
  picked.alignmentPoint!.forEach((coordinate, axis) => expect(coordinate).toBeCloseTo(expectedPoint[axis], 7));
  await page.getByRole('button', { name: 'Set center', exact: true }).click(); await settled(page);
  const centered = await snapshot(page); expect(centered.records).toEqual(centered.gpuRecords); expect(centered.masks).toEqual(before.masks);
  centered.records.forEach((record, id) => {
    record.position.forEach((coordinate, axis) => expect(coordinate).toBeCloseTo(Math.fround(before.records[id].position[axis] - expectedPoint[axis]), 6));
    expect(record.attributes).toEqual(before.records[id].attributes);
  });
  await tools(page).getByRole('button', { name: 'Undo', exact: true }).click(); await settled(page);
  const undone = await snapshot(page); expect(undone.records).toEqual(before.records); expect(undone.masks).toEqual(before.masks); expect(undone.exported).toBe(before.exported);
  await tools(page).getByRole('button', { name: 'Redo', exact: true }).click(); await settled(page);
  const redone = await snapshot(page); expect(redone.records).toEqual(centered.records); expect(redone.exported).toBe(centered.exported);
  await info.attach('alignment-dismiss-versus-real-contributor.json', { contentType: 'application/json', body: JSON.stringify({ before, observed, dismissed, picked, centered, undone, redone }) });
});

test('Alignment dismissal over Reset camera preserves the picked draft and current pose until a fresh toolbar press', async ({ page }, info) => {
  await baseline(page); await armCenter(page); await contributor(page);
  await expect(page.getByRole('button', { name: 'Set center', exact: true })).toBeEnabled();
  await page.evaluate(() => window.alignmentHarness.navigate()); const before = await snapshot(page);
  await page.evaluate(() => window.alignmentHarness.keyboardStart()); await open(page);
  await page.keyboard.press('Escape'); await expect(menu(page)).toHaveCount(0);
  expect((await page.evaluate(() => window.alignmentHarness.state())).alignmentPoint).toEqual(before.alignmentPoint);
  await open(page);
  const reset = page.getByRole('button', { name: 'Reset camera', exact: true }), box = (await reset.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2); await expect(menu(page)).toHaveCount(0);
  const observed = await passiveFinish(page), dismissed = await snapshot(page); retained(dismissed, before);
  await reset.click(); await settled(page); const resetState = await snapshot(page);
  expect(resetState.alignmentTool).toBeNull(); expect(resetState.alignmentPoint).toBeNull();
  const expected = [...before.defaultCamera]; expected[10] = before.camera[10]; expect(resetState.camera).toEqual(expected);
  expect(resetState.camera).not.toEqual(before.camera); expect(resetState.records).toEqual(before.records); expect(resetState.exported).toBe(before.exported);
  expect(resetState.summary.canRedo).toBe(true);
  await info.attach('alignment-dismissed-toolbar-press.json', { contentType: 'application/json', body: JSON.stringify({ before, observed, dismissed, resetState }) });
});

for (const button of ['right', 'middle'] as const) test(`Alignment owns outside ${button} context/auxiliary activations and releases the next real press`, async ({ page }, info) => {
  const initial = await baseline(page); await chooseSelectionTool(page, 'Color picker');
  const tolerance = tools(page).getByRole('slider', { name: 'Selection tolerance', exact: true });
  const entry = tools(page).getByRole('spinbutton', { name: 'Tolerance percent', exact: true });
  await tolerance.scrollIntoViewIfNeeded(); const before = await snapshot(page);
  await page.evaluate(() => window.alignmentHarness.keyboardStart()); await open(page); await observe(tolerance);
  const box = (await tolerance.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button });
  await expect(menu(page)).toHaveCount(0); await expect(entry).toHaveCount(0);
  const consumed = await observations(page), expected = button === 'right' ? 'contextmenu' : 'auxclick';
  expect(consumed.events.some(event => event.type === expected)).toBe(true);
  expect(consumed.events.every(event => event.trusted && event.prevented)).toBe(true); expect(consumed.targetEvents).toEqual([]);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button });
  if (button === 'right') { await expect(entry).toBeFocused(); await entry.press('Escape'); await expect(entry).toHaveCount(0); }
  else {
    const fresh = await observations(page); expect(fresh.targetEvents).toContain('pointerdown'); expect(fresh.targetEvents).toContain('mousedown');
    for (const activation of fresh.events.slice(consumed.events.length)) expect(fresh.targetEvents).toContain(activation.type);
    await page.keyboard.press('Escape');
  }
  await page.evaluate(() => window.alignmentMenuPressProbe?.stop());
  const observed = await passiveFinish(page); retained(await snapshot(page), before);
  const redone = await replay(page, initial.deleted);
  await info.attach('alignment-owned-nonprimary-press.json', { contentType: 'application/json', body: JSON.stringify({ button, before, consumed, observed, redone }) });
});
