import { expect, test, type Locator, type Page } from '@playwright/test';
import type {} from './opacity-harness';

const scene = (page: Page) => page.getByLabel('SplatView scene', { exact: true });
const tools = (page: Page) => page.getByRole('complementary', { name: 'Tools', exact: true });
const saveButton = (page: Page) => page.getByRole('button', { name: 'Save scene', exact: true });
const saveDialog = (page: Page) => page.getByRole('dialog', { name: 'Save scene', exact: true });
const unsaved = (page: Page) => page.getByRole('dialog', { name: 'Unsaved changes', exact: true });
const output = (page: Page) => page.getByRole('dialog', { name: 'Download prepared. Keep the file before continuing.', exact: true });
const snapshot = (page: Page) => page.evaluate(() => window.opacityHarness.snapshot());
type Snapshot = Awaited<ReturnType<Window['opacityHarness']['snapshot']>>;

async function scopeState(page: Page) {
  return page.evaluate(async () => {
    // Resolve the same Vite module instance as App, without adding a harness.
    const moduleUrl = new URL('../src/app/store.ts', location.href).href;
    const { useApp } = await import(/* @vite-ignore */ moduleUrl) as typeof import('../src/app/store');
    const state = useApp.getState();
    return { dirty: state.dirty, modifiers: state.selectionModifiers, navigationPrompt: state.navigationPrompt,
      outputPending: state.outputPending, exportOpen: state.exportOpen, hasScene: !!state.summary };
  });
}
async function settled(page: Page) {
  await expect.poll(() => page.evaluate(() => {
    const state = window.opacityHarness.state();
    return { busy: state.busy, pending: state.pending, renderer: state.rendererState, recovery: state.selectionRecovery, error: state.error };
  })).toEqual({ busy: false, pending: false, renderer: 'ready', recovery: 'idle', error: null });
}
async function boot(page: Page, mode: 'basic' | 'pro' = 'pro') {
  await page.addInitScript(value => localStorage.setItem('splatview.tools-mode.v1', value), mode);
  await page.goto('/e2e/opacity-harness.html');
  await page.waitForFunction(() => window.geometryViewerError || window.opacityHarness?.ready());
  expect(await page.evaluate(() => window.geometryViewerError)).toBeUndefined();
  await page.evaluate(() => window.opacityHarness.load('input-scope-literals.ply'));
  if (!(await page.evaluate(() => window.opacityHarness.state())).toolsOpen)
    await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await settled(page);
}
async function dirtyScene(page: Page) {
  expect(await page.evaluate(() => window.opacityHarness.command({ command: 'single', index: 2, operation: 0 }))).toBe(true);
  expect(await page.evaluate(() => window.opacityHarness.command({ command: 'delete' }))).toBe(true);
  await settled(page);
  await expect.poll(() => scopeState(page)).toMatchObject({ dirty: true });
  const value = await snapshot(page);
  expect(value.masks).toEqual([0, 0, 2, 0, 0, 0]);
  expect(value.gpuMasks).toEqual(value.masks); expect(value.summary.canUndo).toBe(true);
  return value;
}
function retained(actual: Snapshot, expected: Snapshot) {
  expect(actual.records).toEqual(expected.records); expect(actual.gpuRecords).toEqual(expected.gpuRecords);
  expect(actual.masks).toEqual(expected.masks); expect(actual.gpuMasks).toEqual(expected.gpuMasks);
  expect(actual.summary.revision).toBe(expected.summary.revision);
  expect(actual.summary.contentRevision).toBe(expected.summary.contentRevision);
  expect(actual.summary.canUndo).toBe(expected.summary.canUndo); expect(actual.summary.canRedo).toBe(expected.summary.canRedo);
  expect(actual.sourceFingerprint).toEqual(expected.sourceFingerprint); expect(actual.document).toEqual(expected.document);
}
async function tabTo(page: Page, target: Locator, backwards = false) {
  await page.keyboard.press(backwards ? 'Shift+Tab' : 'Tab'); await expect(target).toBeFocused();
}
async function requestClose(page: Page) {
  await tools(page).getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.getByRole('button', { name: 'Close scene', exact: true }).click();
  await expect(unsaved(page)).toBeVisible();
  await expect(unsaved(page).getByRole('button', { name: 'Stay', exact: true })).toBeFocused();
}
async function downloadByKeyboard(page: Page) {
  const downloaded = page.waitForEvent('download');
  await page.keyboard.press('Enter');
  expect((await downloaded).suggestedFilename()).toMatch(/\.ply$/);
  await settled(page); await expect(output(page)).toBeVisible();
  await expect(output(page).getByRole('button', { name: 'I have kept the file', exact: true })).toBeFocused();
}
async function frames(page: Page, count = 3) {
  await page.evaluate(async total => {
    for (let frame = 0; frame < total; frame++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  }, count);
}

test.afterEach(async ({ page }) => { await page.evaluate(() => window.opacityHarness?.stop()); });

for (const mode of ['basic', 'pro'] as const) test(`${mode} UI focus denies scene edits; actual canvas focus admits native Undo and Redo`, async ({ page }) => {
  await boot(page, mode); const before = await dirtyScene(page);
  const control = page.getByRole('button', { name: 'Tools', exact: true });
  await control.focus(); await expect(control).toBeFocused();
  await page.evaluate(() => window.opacityHarness.observe());
  for (const key of ['b', 'i', 'Delete', 'ControlOrMeta+z']) await page.keyboard.press(key);
  await settled(page); const denied = await snapshot(page); retained(denied, before);
  expect(denied.tool).toBe(before.tool);
  expect((await page.evaluate(() => window.opacityHarness.commands())).filter(command => ['undo', 'redo', 'delete', 'invert'].includes(command))).toEqual([]);
  await scene(page).focus(); await expect(scene(page)).toBeFocused();
  await page.keyboard.press('ControlOrMeta+z'); await settled(page);
  await expect.poll(async () => (await snapshot(page)).masks).toEqual([0, 0, 1, 0, 0, 0]);
  const undone = await snapshot(page);
  expect(undone.gpuMasks).toEqual(undone.masks); expect(undone.summary.canRedo).toBe(true);
  expect(undone.records).toEqual(before.records); expect(undone.gpuRecords).toEqual(before.gpuRecords);
  await page.keyboard.press('ControlOrMeta+Shift+z'); await settled(page);
  await expect.poll(async () => (await snapshot(page)).masks).toEqual(before.masks);
  const redone = await snapshot(page);
  expect(redone.gpuMasks).toEqual(before.gpuMasks); expect(redone.records).toEqual(before.records);
  expect(redone.summary.canRedo).toBe(false);
  const commands = await page.evaluate(() => window.opacityHarness.commands());
  expect(commands.filter(command => command === 'undo' || command === 'redo')).toEqual(['undo', 'redo']);
});

test('Save focuses Format, contains all four controls in both directions, and Escape restores its opener', async ({ page }) => {
  await boot(page); const before = await snapshot(page);
  await saveButton(page).click(); const dialog = saveDialog(page);
  const format = dialog.getByRole('combobox', { name: 'Export format', exact: true });
  const scope = dialog.getByRole('combobox', { name: 'Export scope', exact: true });
  const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true });
  const download = dialog.getByRole('button', { name: 'Download', exact: true });
  await expect(dialog).toHaveAttribute('aria-modal', 'true'); await expect(format).toBeFocused();
  for (const target of [scope, cancel, download, format]) await tabTo(page, target);
  for (const target of [download, cancel, scope, format]) await tabTo(page, target, true);
  for (const key of ['b', 'i', 'Delete', 'ControlOrMeta+z']) await page.keyboard.press(key);
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(saveButton(page)).toBeFocused();
  await settled(page); retained(await snapshot(page), before);
});

test('dirty Unsaved contains Stay, Discard and Save, Escape stays, and explicit keyboard Discard closes', async ({ page }) => {
  await boot(page); const before = await dirtyScene(page); await requestClose(page);
  const stay = unsaved(page).getByRole('button', { name: 'Stay', exact: true });
  const discard = unsaved(page).getByRole('button', { name: 'Discard and close', exact: true });
  const save = unsaved(page).getByRole('button', { name: 'Save', exact: true });
  await expect(unsaved(page)).toHaveAttribute('aria-modal', 'true');
  await tabTo(page, save, true); await tabTo(page, stay); await tabTo(page, discard); await tabTo(page, save); await tabTo(page, stay);
  for (const key of ['b', 'i', 'Delete', 'ControlOrMeta+z']) await page.keyboard.press(key);
  await page.keyboard.press('Escape'); await expect(unsaved(page)).toHaveCount(0);
  await expect(tools(page).getByRole('button', { name: 'Settings', exact: true })).toBeFocused();
  retained(await snapshot(page), before); await expect.poll(() => scopeState(page)).toMatchObject({ dirty: true, hasScene: true });
  await requestClose(page); await page.keyboard.press('Enter'); await expect(unsaved(page)).toHaveCount(0);
  retained(await snapshot(page), before);
  await requestClose(page); await tabTo(page, discard); await page.keyboard.press('Enter');
  await expect.poll(() => scopeState(page)).toMatchObject({ hasScene: false, dirty: false, navigationPrompt: false });
  await expect(unsaved(page)).toHaveCount(0); await expect(scene(page)).toHaveAttribute('data-navigation', 'orbit');
});

test('Save to real Download transfers focus to acknowledgement; Escape stays dirty and explicit acknowledgement preserves the origin', async ({ page }) => {
  await boot(page); const before = await dirtyScene(page);
  for (const acknowledge of [false, true]) {
    await saveButton(page).click();
    await saveDialog(page).getByRole('button', { name: 'Download', exact: true }).focus();
    await downloadByKeyboard(page); await expect(saveDialog(page)).toHaveCount(0);
    const kept = output(page).getByRole('button', { name: 'I have kept the file', exact: true });
    const stay = output(page).getByRole('button', { name: 'Stay', exact: true });
    await tabTo(page, stay, true); await tabTo(page, kept); await tabTo(page, stay); await tabTo(page, kept);
    for (const key of ['b', 'i', 'Delete', 'ControlOrMeta+z']) await page.keyboard.press(key);
    await page.keyboard.press(acknowledge ? 'Enter' : 'Escape'); await expect(output(page)).toHaveCount(0);
    await expect(saveButton(page)).toBeFocused();
    await expect.poll(() => scopeState(page)).toMatchObject({ dirty: !acknowledge, hasScene: true, outputPending: false });
    retained(await snapshot(page), before);
  }
});

test('Unsaved Save transfers to output, Escape returns to Stay, and a kept-file acknowledgement completes the pending close', async ({ page }) => {
  await boot(page); const before = await dirtyScene(page); await requestClose(page);
  const save = unsaved(page).getByRole('button', { name: 'Save', exact: true });
  await tabTo(page, save, true); await downloadByKeyboard(page);
  await expect(unsaved(page)).toHaveCount(0); await page.keyboard.press('Escape');
  await expect(output(page)).toHaveCount(0); await expect(unsaved(page)).toBeVisible();
  await expect(unsaved(page).getByRole('button', { name: 'Stay', exact: true })).toBeFocused();
  retained(await snapshot(page), before);
  await expect.poll(() => scopeState(page)).toMatchObject({ dirty: true, hasScene: true, navigationPrompt: true });
  await tabTo(page, save, true); await downloadByKeyboard(page); await page.keyboard.press('Enter');
  await expect.poll(() => scopeState(page)).toMatchObject({ dirty: false, hasScene: false, outputPending: false, navigationPrompt: false });
  await expect(output(page)).toHaveCount(0); await expect(unsaved(page)).toHaveCount(0);
  await expect(tools(page).getByRole('button', { name: 'Settings', exact: true })).toBeFocused();
});

test('hovering SelectionMenus clears a held native W while canvas remains focused and repeat cannot restart it', async ({ page }) => {
  await boot(page); const before = await snapshot(page);
  const cameraActive = () => page.evaluate(() => window.geometryViewer.controllerForSourceNavigation().camera!.active);
  await scene(page).focus(); await page.keyboard.down('w');
  try {
    await expect.poll(cameraActive).toBe(true);
    await expect.poll(() => page.evaluate(() => window.opacityHarness.state().camera)).not.toEqual(before.camera);
    await tools(page).getByRole('button', { name: 'Selection tool', exact: true }).hover();
    const menu = page.getByRole('menu', { name: 'Selection tools', exact: true });
    await expect(menu).toBeVisible(); await expect(scene(page)).toBeFocused(); await expect.poll(cameraActive).toBe(false);
    const stopped = await page.evaluate(() => window.opacityHarness.state().camera);
    await page.mouse.move(30, 600); await expect(menu).toHaveCount(0); await expect(scene(page)).toBeFocused();
    await page.keyboard.down('w'); // Playwright delivers repeat=true for this still-held key.
    await frames(page); expect(await cameraActive()).toBe(false);
    expect(await page.evaluate(() => window.opacityHarness.state().camera)).toEqual(stopped);
    await page.keyboard.up('w'); await page.keyboard.down('w');
    await expect.poll(cameraActive).toBe(true);
    await expect.poll(() => page.evaluate(() => window.opacityHarness.state().camera)).not.toEqual(stopped);
  } finally { await page.keyboard.up('w'); }
  await expect.poll(cameraActive).toBe(false); retained(await snapshot(page), before);
});

test('SelectionHelp permits a trusted native Copy of selected help text without preventing its default action', async ({ page }) => {
  await boot(page); const before = await snapshot(page);
  await tools(page).getByRole('button', { name: 'Selection controls', exact: true }).click();
  const help = page.getByRole('dialog', { name: 'Selection controls', exact: true });
  const body = help.getByLabel('Selection control shortcuts', { exact: true });
  await body.focus();
  const selected = await body.evaluate(element => {
    const cell = element.querySelector('td')!, range = document.createRange(), selection = window.getSelection()!;
    range.selectNodeContents(cell); selection.removeAllRanges(); selection.addRange(range);
    document.addEventListener('copy', event => queueMicrotask(() => {
      document.documentElement.dataset.inputScopeCopy = JSON.stringify({ trusted: event.isTrusted, prevented: event.defaultPrevented,
        text: window.getSelection()?.toString() });
    }), { once: true });
    return selection.toString();
  });
  expect(selected.length).toBeGreaterThan(0); await page.keyboard.press('ControlOrMeta+c');
  await expect.poll(() => page.evaluate(() => {
    const value = document.documentElement.dataset.inputScopeCopy; return value ? JSON.parse(value) : null;
  })).toEqual({ trusted: true, prevented: false, text: selected });
  await expect(help).toBeVisible(); retained(await snapshot(page), before);
  await page.keyboard.press('Escape'); await expect(help).toHaveCount(0);
});

test('real Tutorial window blur and outside Shift release do not quarantine a fresh trusted Shift after return', async ({ page, context }) => {
  await boot(page); const before = await snapshot(page);
  await scene(page).focus(); await page.keyboard.down('Shift');
  await expect.poll(() => scopeState(page)).toMatchObject({ modifiers: 1 });
  await page.keyboard.up('Shift'); await expect.poll(() => scopeState(page)).toMatchObject({ modifiers: 0 });
  await tools(page).getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.getByRole('tab', { name: 'Help', exact: true }).click();
  await settings.getByRole('button', { name: 'Tutorial', exact: true }).click();
  const tutorial = page.getByRole('dialog', { name: 'Tutorial', exact: true });
  await expect(tutorial).toBeVisible(); await tutorial.locator('.tutorial-card-body').focus();
  await page.evaluate(() => document.addEventListener('keydown', event => {
    if (event.code === 'ShiftLeft') document.documentElement.dataset.inputScopeTourShiftTrusted = String(event.isTrusted);
  }, { once: true, capture: true }));
  await page.keyboard.down('Shift'); // This held key belongs to the active tour.
  await expect(page.locator('html')).toHaveAttribute('data-input-scope-tour-shift-trusted', 'true');
  await expect.poll(() => scopeState(page)).toMatchObject({ modifiers: 0 });
  const outside = await context.newPage();
  const session = await context.newCDPSession(page), outsideSession = await context.newCDPSession(outside);
  try {
    // Playwright normally emulates focus on every page. Disable that emulation
    // on both targets so bringToFront produces an actual browser window blur.
    await session.send('Emulation.setFocusEmulationEnabled', { enabled: false });
    await outsideSession.send('Emulation.setFocusEmulationEnabled', { enabled: false });
    await outside.goto('about:blank'); await page.bringToFront();
    await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true);
    await outside.bringToFront();
    await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(false);
    await outside.keyboard.up('Shift');
    await page.bringToFront(); await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true);
    await expect(tutorial).toBeVisible(); await expect.poll(() => scopeState(page)).toMatchObject({ modifiers: 0 });
    await tutorial.getByRole('button', { name: 'Close tutorial', exact: true }).click();
    await expect(tutorial).toHaveCount(0); await scene(page).focus();
    await page.evaluate(() => document.addEventListener('keydown', event => {
      if (event.code === 'ShiftLeft') document.documentElement.dataset.inputScopeShiftTrusted = String(event.isTrusted);
    }, { once: true }));
    // A separate page received the release, so bypass Playwright's per-page held
    // key bookkeeping and deliver a genuinely fresh, trusted browser keydown.
    await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Shift', code: 'ShiftLeft',
      windowsVirtualKeyCode: 16, nativeVirtualKeyCode: 16, modifiers: 8 });
    await expect.poll(() => scopeState(page)).toMatchObject({ modifiers: 1 });
    await expect(page.locator('html')).toHaveAttribute('data-input-scope-shift-trusted', 'true');
    await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Shift', code: 'ShiftLeft',
      windowsVirtualKeyCode: 16, nativeVirtualKeyCode: 16, modifiers: 0 });
    await expect.poll(() => scopeState(page)).toMatchObject({ modifiers: 0 });
    retained(await snapshot(page), before);
  } finally {
    await Promise.all([session.send('Emulation.setFocusEmulationEnabled', { enabled: true }),
      outsideSession.send('Emulation.setFocusEmulationEnabled', { enabled: true })]);
    await page.keyboard.up('Shift');
    await Promise.all([session.detach(), outsideSession.detach()]); await outside.close();
  }
});

test('composing Escape and tutorial-owned key repeats cannot become a late scene shortcut after close', async ({ page }) => {
  await boot(page); const before = await dirtyScene(page);
  await tools(page).getByRole('button', {name: 'Settings', exact: true}).click();
  const settings = page.locator('.settings-dialog[role="dialog"]');
  await settings.getByRole('tab', {name: 'Help', exact: true}).click();
  await settings.locator('[data-tutorial-replay]').click();
  const layer = page.locator('.tutorial-layer'), card = layer.getByRole('dialog', {name: 'Tutorial', exact: true});
  await expect(layer).toHaveAttribute('data-tutorial-step', '1');
  const body = card.locator('.tutorial-card-body'); await body.focus();
  await body.evaluate(element => {
    element.dispatchEvent(new CompositionEvent('compositionstart', {bubbles: true}));
    element.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', code: 'Escape', isComposing: true, bubbles: true, cancelable: true}));
    element.dispatchEvent(new KeyboardEvent('keyup', {key: 'Escape', code: 'Escape', bubbles: true}));
    element.dispatchEvent(new CompositionEvent('compositionend', {bubbles: true}));
  });
  await expect(layer).toHaveAttribute('data-tutorial-step', '1'); retained(await snapshot(page), before);
  await page.keyboard.down('g'); await page.keyboard.down('g'); await page.keyboard.press('Escape');
  await expect(layer).toHaveCount(0); await expect(scene(page)).toBeFocused();
  const closedTool = (await page.evaluate(() => window.opacityHarness.state())).tool;
  await page.keyboard.down('g');
  expect((await page.evaluate(() => window.opacityHarness.state())).tool).toBe(closedTool);
  await page.keyboard.up('g'); retained(await snapshot(page), before);
  // A released key starts a fresh physical activation; ownership quarantine
  // must end rather than disable the ordinary focused-canvas Fill shortcut.
  await page.keyboard.press('g');
  await expect.poll(() => page.evaluate(() => window.opacityHarness.state().tool)).toBe('fill');
  retained(await snapshot(page), before); expect((await scopeState(page)).modifiers).toBe(0);
});
