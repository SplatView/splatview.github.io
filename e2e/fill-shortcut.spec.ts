import { expect, test, type Page } from '@playwright/test';
import { chooseSelectionTool, selectionToolTrigger } from './selectTool';
import { fillPly, fillPositions } from './fill-fixture';
import type {} from './fill-shortcut-harness';

type Snapshot = Awaited<ReturnType<Window['fillShortcutApp']['snapshot']>>;
const bytes = fillPly(), scene = (page: Page) => page.getByLabel('SplatView scene', { exact: true });
const snapshot = (page: Page) => page.evaluate(() => window.fillShortcutApp.snapshot());
function exact(value: Snapshot, ids: number[]) {
  expect(value.ids).toEqual(ids); expect(value.gpu).toEqual(fillPositions.map((_, id) => Number(ids.includes(id))));
  expect(value.summary.selected).toBe(ids.length);
}
function preserved(before: Snapshot, after: Snapshot) {
  expect(after.selectedBytes).toEqual(before.selectedBytes); expect(after.allBytes).toEqual(before.allBytes); expect(after.gpu).toEqual(before.gpu);
  expect(after.summary.contentRevision).toBe(before.summary.contentRevision);
  expect(after.summary.canUndo).toBe(before.summary.canUndo); expect(after.summary.canRedo).toBe(before.summary.canRedo); expect(after.dirty).toBe(before.dirty);
}
function settledMapResources(value: Snapshot, completedOwner: boolean) {
  // Compute the bounded depth/opacity shape independently from the actual
  // framebuffer. A live cache legitimately retains one CPU and one native
  // lease after the completed-pick checkpoint ends; no transient lease may
  // remain. Native storage adds one source-membership bitset.
  const [fullWidth, fullHeight] = value.framebuffer, scale = Math.min(1, Math.sqrt(262_144 / (fullWidth * fullHeight)));
  const width = Math.max(1, Math.floor(fullWidth * scale)), height = Math.max(1, Math.floor(fullHeight * scale));
  const cpuBytes = width * height * 8, nativeBytes = cpuBytes + Math.ceil(fillPositions.length / 32) * 4;
  expect(value.activeMap).toEqual({ id: value.summary.selectionMapId, width, height, fullWidth, fullHeight,
    colors: false, visible: false, allocationBytes: cpuBytes, cpuBytes });
  expect(value.summary.selectionMapId).not.toBeNull(); expect(value.summary.selectionMapRetainedIds).toEqual([value.summary.selectionMapId]);
  // Idle GPU scratch stays pooled under the work ledger between queries;
  // every other work lease must be exactly one CPU and one native map lease.
  const leases = [...value.workLeases];
  for (const bytes of [cpuBytes, nativeBytes]) { const at = leases.indexOf(bytes); expect(at).toBeGreaterThanOrEqual(0); leases.splice(at, 1); }
  expect(value.scratch.activeBuffers).toBe(0); expect(leases).toHaveLength(value.scratch.idleBuffers);
  expect(leases.reduce((sum, bytes) => sum + bytes, 0)).toBe(value.scratch.idleBytes);
  expect(value.summary.selectionMapBytes).toBe(nativeBytes);
  expect(value.work).toBe(cpuBytes + nativeBytes + value.scratch.idleBytes); expect(value.summary.pendingSelectionMapId).toBeNull();
  expect(value.summary.selectionDraft).toBe(false); expect(value.summary.pending).toBe(false); expect(value.pending).toBe(0); expect(value.records).toEqual([]);
  expect(value.summary.toleranceSessionId).toBe(completedOwner ? value.owner : null);
  expect(value.summary.toleranceMapId).toBe(completedOwner ? value.summary.selectionMapId : null);
  if (completedOwner) expect(value.owner).not.toBeNull(); else expect(value.owner).toBeNull();
}
function retiredMapResources(value: Snapshot) {
  expect(value.activeMap).toBeNull(); expect(value.owner).toBeNull(); expect(value.pending).toBe(0); expect(value.records).toEqual([]);
  expect(value.summary.toleranceSessionId).toBeNull(); expect(value.summary.toleranceMapId).toBeNull();
  expect(value.summary.selectionMapId).toBeNull(); expect(value.summary.selectionMapRetainedIds).toEqual([]); expect(value.summary.selectionMapBytes).toBe(0);
  expect(value.summary.pendingSelectionMapId).toBeNull(); expect(value.summary.pending).toBe(false); expect(value.summary.selectionDraft).toBe(false);
  expect(value.workLeases).toEqual([]); expect(value.work).toBe(0);
}
async function retireMaps(page: Page, before: Snapshot) {
  await page.evaluate(() => window.fillShortcutApp.invalidateMaps()); const retired = await snapshot(page);
  preserved(before, retired); retiredMapResources(retired); return retired;
}
async function open(page: Page, mode: 'basic') {
  await page.goto('/'); await expect(page.getByRole('button', { name: 'Open scene', exact: true })).toBeEnabled();
  await page.getByLabel('Open scene files').setInputFiles({ name: 'fill-shortcut.ply', mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) });
  await expect(page).toHaveTitle('fill-shortcut.ply — SplatView');
  await page.mouse.move(640, 400); await expect(page.locator('main')).not.toHaveClass(/chrome-hidden/);
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await expect.poll(() => page.evaluate(async () => {
    const url = performance.getEntriesByType('resource').find(entry => new URL(entry.name).pathname === '/src/app/store.ts')!.name;
    return (await import(/* @vite-ignore */ url)).useApp.getState().mode;
  })).toBe(mode);
  await chooseSelectionTool(page, 'Fill');
  await page.evaluate(async () => {
    const url = performance.getEntriesByType('resource').find(entry => new URL(entry.name).pathname === '/src/app/controller.ts')!.name;
    const { AppController } = await import(/* @vite-ignore */ url);
    const probeUrl = '/e2e/fill-shortcut-harness.ts', { installFillShortcutProbe } = await import(/* @vite-ignore */ probeUrl);
    const original = AppController.prototype.setSelectionOperation;
    AppController.prototype.setSelectionOperation = function(operation: number) {
      AppController.prototype.setSelectionOperation = original; window.fillShortcutApp = installFillShortcutProbe(this); return original.call(this, operation);
    };
  });
  await page.getByRole('button', { name: 'Replace', exact: true }).click();
  await page.evaluate(mode => window.fillShortcutApp.profiles(mode), mode);
  await page.evaluate(() => window.fillShortcutApp.baseline());
  const value = await snapshot(page); exact(value, [3]); expect(value.summary.canRedo).toBe(true);
  return page.evaluate(() => window.fillShortcutApp.centers());
}
async function click(page: Page, point: number[]) { await page.mouse.click(point[0], point[1]); }
async function polygon(page: Page) {
  await chooseSelectionTool(page, 'Polygon');
  const points = await page.evaluate(() => window.fillShortcutApp.outline());
  for (const point of points) await click(page, point);
  const value = await snapshot(page); exact(value, [0, 1, 2]); expect(value.active).toBe(true); expect(value.summary.selectionDraft).toBe(true);
  return points;
}
async function dispatchG(page: Page, options: Pick<KeyboardEventInit, 'repeat' | 'isComposing' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'> = {}, alreadyHandled = false) {
  return page.evaluate(({ options, alreadyHandled }) => {
    const event = new KeyboardEvent('keydown', { key: 'g', code: 'KeyG', bubbles: true, cancelable: true, ...options });
    if (alreadyHandled) event.preventDefault();
    document.activeElement!.dispatchEvent(event); return event.defaultPrevented;
  }, { options, alreadyHandled });
}

// web-lite has one Tools profile (processing.advanced excludes Pro).
for (const mode of ['basic'] as const) test.describe(`${mode} focused browser Fill shortcut`, () => {
  for (const tool of ['Color picker', 'Fill'] as const) test(`fresh G ends a completed ${tool} owner and preserves its committed selection and history`, async ({ page }) => {
    const centers = await open(page, mode);
    await chooseSelectionTool(page, tool);
    await page.evaluate(() => window.fillShortcutApp.tolerance(.1)); await click(page, centers[0]);
    const before = await snapshot(page); exact(before, tool === 'Fill' ? [0] : [0, 1, 2, 3]); expect(before.owner).not.toBeNull();
    await scene(page).focus(); await page.keyboard.press('g');
    const after = await snapshot(page); preserved(before, after); expect(after.tool).toBe('fill'); expect(after.owner).toBeNull();
    expect(after.traffic.filter(command => command.command === 'endTolerance')).toEqual([{ command: 'endTolerance', sessionId: before.owner }]);
    expect(after.fly).toBe(false); expect(after.autoOrbit).toBe(false);
    if (tool === 'Fill') {
      settledMapResources(before, true); settledMapResources(after, false);
      expect(after.activeMap).toEqual(before.activeMap); expect(after.workLeases).toEqual(before.workLeases); expect(after.counters.maps).toBe(before.counters.maps);
    } else retiredMapResources(after);
    await page.evaluate(() => window.fillShortcutApp.tolerance(1)); preserved(after, await snapshot(page));
    expect((await snapshot(page)).traffic.filter(command => command.command === 'fillTolerance' || command.command === 'colorTolerance')).toHaveLength(0);
    await page.getByRole('button', { name: 'Undo', exact: true }).click(); exact(await snapshot(page), [3]);
    await page.getByRole('button', { name: 'Redo', exact: true }).click(); const redone = await snapshot(page); exact(redone, before.ids);
    await page.getByRole('button', { name: 'Selection tool', exact: true }).click();
    const fill = page.getByRole('menu', { name: 'Selection tools', exact: true }).getByRole('menuitemradio', { name: 'Fill', exact: true });
    await expect(fill).toHaveAttribute('title', 'Fill (G)\nClick a patch to select its connected area in the current view');
    await expect(fill).toHaveAttribute('aria-keyshortcuts', 'G'); await expect(fill).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Escape');
    await retireMaps(page, redone);
  });

  test('physical repeat consumes no further cleanup, while an active Fill button preserves the newly completed owner', async ({ page }) => {
    const centers = await open(page, mode); await scene(page).focus(); await page.keyboard.down('g');
    await click(page, centers[0]); const before = await snapshot(page); exact(before, [0]); expect(before.owner).not.toBeNull();
    await page.keyboard.down('g'); const repeated = await snapshot(page); preserved(before, repeated);
    expect(repeated.owner).toBe(before.owner); expect(repeated.counters).toEqual(before.counters); expect(repeated.traffic).toEqual(before.traffic);
    expect(await dispatchG(page, { repeat: true })).toBe(true); expect((await snapshot(page)).counters).toEqual(repeated.counters);
    await chooseSelectionTool(page, 'Fill'); const button = await snapshot(page); preserved(before, button);
    expect(button.owner).toBe(before.owner); expect(button.counters.cancel).toBe(before.counters.cancel); expect(button.counters.end).toBe(before.counters.end);
    await page.evaluate(() => window.fillShortcutApp.tolerance(1)); const amended = await snapshot(page); exact(amended, [0, 1, 2]);
    expect(amended.owner).toBe(before.owner); expect(amended.traffic.filter(command => command.command === 'fillTolerance')).toHaveLength(1);
    await page.keyboard.up('g'); await scene(page).focus(); const armed = await snapshot(page); await page.keyboard.press('g');
    const rearmed = await snapshot(page); preserved(armed, rearmed); expect(rearmed.owner).toBeNull();
    expect(rearmed.counters.cancel - armed.counters.cancel).toBe(1); expect(rearmed.counters.end - armed.counters.end).toBe(1);
    expect(rearmed.traffic.filter(command => command.command === 'endTolerance')).toHaveLength(1);
    settledMapResources(rearmed, false); await retireMaps(page, rearmed);
  });

  test('fresh G cancels an unfinished Polygon exactly once, restores baseline and Redo, and ignores its late release', async ({ page }) => {
    await open(page, mode); const before = await snapshot(page); const points = await polygon(page);
    const last = points.at(-1)!; await page.mouse.move(last[0], last[1]); await page.mouse.down();
    const preview = await snapshot(page); await page.keyboard.press('g'); const after = await snapshot(page); exact(after, [3]);
    preserved(before, after); expect(after.tool).toBe('fill'); expect(after.active).toBe(false); expect(after.summary.selectionDraft).toBe(false);
    expect(after.traffic.filter(command => command.command === 'cancelSelection')).toHaveLength(1);
    // The shared feedback SVG now draws the newly armed Fill cursor. The old
    // polygon geometry must retire without removing that current feedback.
    await expect(page.locator('.manual-selection-feedback[data-selection-tool="polygon"]')).toHaveCount(0);
    const feedback = page.locator('.manual-selection-feedback[data-selection-tool="fill"]');
    await expect(feedback).toHaveCount(1);
    await expect(feedback.locator(':scope > polyline, :scope > line, :scope > circle')).toHaveCount(0);
    await page.mouse.up(); const released = await snapshot(page); preserved(after, released);
    expect(released.traffic.filter(command => command.command === 'fillPick')).toHaveLength(0);
    expect(released.traffic.filter(command => command.command === 'polygon')).toHaveLength(preview.traffic.filter(command => command.command === 'polygon').length);
    await page.getByRole('button', { name: 'Redo', exact: true }).click(); exact(await snapshot(page), [2]);
  });

  for (const tool of ['Color picker', 'Fill'] as const) test(`G cancels the captured ${tool} FIFO, and its older cancellation cannot cancel a later Fill release`, async ({ page }) => {
    const centers = await open(page, mode); const baseline = await snapshot(page);
    await chooseSelectionTool(page, tool);
    await page.evaluate(tool => window.fillShortcutApp.hold(tool === 'Fill' ? 'map' : 'pick'), tool);
    await click(page, centers[0]); await page.waitForFunction(() => window.fillShortcutApp.control.entered);
    await click(page, centers[3]); expect(await page.evaluate(() => window.fillShortcutApp.state().pending)).toBe(2);
    await scene(page).focus(); await page.keyboard.press('g');
    const cancelled = await page.evaluate(() => window.fillShortcutApp.state()); expect(cancelled.records.map(record => record.aborted)).toEqual([true, true]);
    await click(page, centers[0]); const fresh = await page.evaluate(() => window.fillShortcutApp.state());
    expect(fresh.records.map(record => record.aborted)).toEqual([true, true, false]);
    expect(await dispatchG(page, { repeat: true })).toBe(true);
    const repeated = await page.evaluate(() => window.fillShortcutApp.state()); expect(repeated.records).toEqual(fresh.records); expect(repeated.counters).toEqual(fresh.counters);
    await page.evaluate(() => window.fillShortcutApp.release()); const after = await snapshot(page); exact(after, [0]);
    settledMapResources(after, true); expect(after.error).toBeNull();
    expect(after.traffic.filter(command => command.command === 'colorPick')).toHaveLength(0);
    expect(after.traffic.filter(command => command.command === 'fillPick')).toHaveLength(1);
    await page.getByRole('button', { name: 'Undo', exact: true }).click(); const undone = await snapshot(page); preserved(baseline, undone);
    expect(undone.owner).toBeNull(); await retireMaps(page, undone);
  });

  test('refused restoration closes admission for fresh and repeated G until explicit recovery succeeds', async ({ page }) => {
    await open(page, mode); const baseline = await snapshot(page); await polygon(page);
    await page.evaluate(() => window.fillShortcutApp.refuseCleanup(true)); await page.keyboard.press('g');
    await expect(page.getByRole('button', { name: 'Restore selection', exact: true })).toBeEnabled();
    const refused = await snapshot(page); exact(refused, [0, 1, 2]); expect(refused.recovery).toBe('required'); expect(refused.cleanupOwned).toBe(true); expect(refused.editing).toBe(false);
    await scene(page).focus(); expect(await dispatchG(page)).toBe(false); expect(await dispatchG(page, { repeat: true })).toBe(false);
    const closed = await snapshot(page); preserved(refused, closed); expect(closed.counters).toEqual(refused.counters); expect(closed.traffic).toEqual(refused.traffic);
    await page.evaluate(() => window.fillShortcutApp.refuseCleanup(false)); await page.getByRole('button', { name: 'Restore selection', exact: true }).click();
    const restored = await snapshot(page); preserved(baseline, restored); expect(restored.recovery).toBe('idle'); expect(restored.cleanupOwned).toBe(false);
    await scene(page).focus(); expect(await dispatchG(page)).toBe(true); expect((await snapshot(page)).tool).toBe('fill');
  });

  test('handled/composing/modified keys and field or unfocused-scene delivery preserve tool and completed owner', async ({ page }) => {
    const centers = await open(page, mode); await click(page, centers[0]); const before = await snapshot(page);
    for (const options of [{ isComposing: true }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }]) {
      await scene(page).focus(); expect(await dispatchG(page, options)).toBe(false);
    }
    expect(await dispatchG(page, {}, true)).toBe(true);
    const checked = await snapshot(page); preserved(before, checked); expect(checked.owner).toBe(before.owner);
    // Composition enters/leaves the editing scope, then Ctrl+G and Meta+G
    // drain browser-owned input. These four camera clears must not touch the
    // completed selection owner, map/pick admission, or native history.
    expect(checked.counters).toEqual({ ...before.counters, clearInput: before.counters.clearInput + 4 });
    expect(checked.camera).toEqual(before.camera); expect(checked.tool).toBe(before.tool);
    // Real focus and keyboard delivery cover controls, including the numeric
    // tolerance editor and a nested contenteditable target.
    await page.getByLabel('Color preset', { exact: true }).focus(); await page.keyboard.press('g');
    await page.getByRole('slider', { name: 'Selection tolerance', exact: true }).focus(); await page.keyboard.press('g');
    await page.getByRole('slider', { name: 'Selection tolerance', exact: true }).click({ button: 'right' });
    await page.getByRole('spinbutton', { name: 'Tolerance percent', exact: true }).press('g');
    await scene(page).focus();
    for (const tag of ['input', 'textarea', 'contenteditable']) {
      await page.evaluate(tag => {
        const element = document.createElement(tag === 'contenteditable' ? 'div' : tag); element.id = 'fill-shortcut-field';
        if (tag === 'contenteditable') element.contentEditable = 'true'; document.body.append(element); element.focus();
      }, tag);
      await page.keyboard.press('g'); await page.locator('#fill-shortcut-field').evaluate(element => element.remove());
    }
    await (await selectionToolTrigger(page, 'Fill')).focus(); await page.keyboard.press('g');
    const after = await snapshot(page); preserved(before, after); expect(after.owner).toBe(before.owner);
    expect(after.counters.cancel).toBe(before.counters.cancel); expect(after.counters.end).toBe(before.counters.end);
    expect(after.counters.maps).toBe(before.counters.maps); expect(after.counters.picks).toBe(before.counters.picks);
    expect(after.camera).toEqual(before.camera); expect(after.tool).toBe(before.tool);
    expect(after.traffic).toEqual(before.traffic);
    await scene(page).focus(); await page.keyboard.press('g'); const rearmed = await snapshot(page);
    expect(rearmed.owner).toBeNull(); settledMapResources(rearmed, false); await retireMaps(page, rearmed);
  });

  test('modal scopes and unrelated busy work refuse G without consuming or canceling selection', async ({ page }) => {
    const centers = await open(page, mode); await click(page, centers[0]); const before = await snapshot(page);
    for (const flag of ['settingsOpen', 'exportOpen', 'navigationPrompt', 'outputPending', 'busy'] as const) {
      await page.evaluate(flag => window.fillShortcutApp.set({ [flag]: true }), flag);
      await scene(page).focus(); const gated = await page.evaluate(() => window.fillShortcutApp.state());
      expect(await dispatchG(page)).toBe(false); expect(await dispatchG(page, { repeat: true })).toBe(false);
      const after = await page.evaluate(() => window.fillShortcutApp.state()); expect(after.owner).toBe(before.owner); expect(after.counters).toEqual(gated.counters);
      await page.evaluate(flag => window.fillShortcutApp.set({ [flag]: false }), flag);
    }
    preserved(before, await snapshot(page));
    await scene(page).focus(); expect(await dispatchG(page)).toBe(true); const rearmed = await snapshot(page);
    expect(rearmed.owner).toBeNull(); settledMapResources(rearmed, false); await retireMaps(page, rearmed);
  });

  test('F/O keep their existing camera behavior, and G stops Fly and auto orbit without starting a pick', async ({ page }) => {
    await open(page, mode); await scene(page).focus();
    const initial = await snapshot(page); await page.keyboard.press('f'); const flipped = await snapshot(page);
    expect(flipped.camera).not.toEqual(initial.camera); expect(flipped.tool).toBe('fill');
    await page.keyboard.press('o'); const orbit = await snapshot(page); expect(orbit.autoOrbit).toBe(true); expect(orbit.tool).toBeNull();
    await page.keyboard.press('g'); const stopped = await snapshot(page); expect(stopped.autoOrbit).toBe(false); expect(stopped.fly).toBe(false); expect(stopped.tool).toBe('fill');
    await page.keyboard.press('v'); expect((await snapshot(page)).fly).toBe(true); await page.keyboard.press('g');
    const armed = await snapshot(page); expect(armed.fly).toBe(false); expect(armed.autoOrbit).toBe(false); expect(armed.tool).toBe('fill');
    expect(armed.traffic.filter(command => command.command === 'fillPick')).toHaveLength(0); exact(armed, [3]);
  });
});
