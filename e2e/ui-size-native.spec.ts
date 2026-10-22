import { expect, test, type Page } from '@playwright/test';
import type {} from './geometry-viewer-harness';
import { queuePly } from './queue-fixture';

async function scene(page: Page) {
  return page.evaluate(async () => {
    const controller = window.geometryViewer.controllerForSourceNavigation(), client = controller.client!;
    const snapshot = await window.geometryViewer.snapshot();
    // Copy every native packed record, including the deleted record, and the
    // complete native mask. The existing snapshot also reads actual GPU masks.
    const records: { first: number; count: number; bytes: number[] }[] = [];
    let masks: number[] = [];
    await client.stream(async (first, count, bytes) => { records.push({ first, count, bytes: Array.from(new Uint8Array(bytes)) }); },
      bytes => { masks = Array.from(new Uint8Array(bytes)); });
    return { ...snapshot, nativeRecords: records, nativeMasks: masks, revision: { ...client.revision } };
  });
}
type Snapshot = Awaited<ReturnType<typeof scene>>;
function expectSceneContent(actual: Snapshot, expected: Snapshot) {
  // Undo/Redo advance observation revisions. Content, masks, view, dirty state,
  // and the executable history endpoints must match their independent oracle.
  for (const key of ['nativeRecords', 'nativeMasks', 'gpuMasks', 'exported', 'capture', 'camera', 'cameraBackground',
    'background', 'dirty', 'sourceFingerprint', 'sourceName'] as const) expect(actual[key], key).toEqual(expected[key]);
  for (const key of ['count', 'visible', 'selected', 'canUndo', 'canRedo'] as const) expect(actual.summary[key], key).toBe(expected.summary[key]);
}

for (const primary of ['Control', 'Meta'] as const) test(`Settings tabs, ${primary} shortcut/focus ownership and Font size preserve native records, masks, camera and executable Redo`, async ({ page }, testInfo) => {
  // Both App primary-modifier branches run in Windows Chromium. Meta uses a
  // test-only platform value; this does not claim a macOS desktop capture.
  if (primary === 'Meta') await page.addInitScript(() => { Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' }); });
  await page.goto('/e2e/geometry-viewer-harness.html');
  await page.waitForFunction(() => window.geometryViewerError || window.geometryViewer?.ready());
  expect(await page.evaluate(() => window.geometryViewerError)).toBeUndefined();
  await page.getByLabel('Open scene files').setInputFiles({ name: 'font-size-dirty-redo.ply', mimeType: 'application/octet-stream', buffer: Buffer.from(queuePly()) });
  await expect(page.getByRole('button', { name: 'Capture image', exact: true })).toBeEnabled();
  await expect.poll(() => page.evaluate(() => !!window.geometryViewer.controllerForSourceNavigation().sourceFingerprint)).toBe(true);
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const original = await scene(page);
  await page.evaluate(async () => {
    const controller = window.geometryViewer.controllerForSourceNavigation();
    // Native edits can publish before their first replacement GPU frame.
    // Join actual color admission before each grade and its history boundary.
    const colorReady = async () => {
      const deadline = performance.now() + 10_000;
      while (!controller.colorControlsEnabled) {
        if (performance.now() >= deadline) throw new Error('Color controls did not become ready for the retained-history fixture.');
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      }
    };
    const grade = [1.2, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (const command of [{ command: 'single', index: 1 }, { command: 'delete' }, { command: 'single', index: 2 },
      { command: 'grade', values: grade }, { command: 'grade', values: [1.5, ...grade.slice(1)] }, { command: 'undo' }]) {
      if (command.command === 'grade' || command.command === 'undo') await colorReady();
      if (!await controller.command(command)) throw new Error(`The font-size retained-history fixture refused ${command.command}.`);
    }
    controller.camera!.orbit(11, -7); controller.cycleBackground(); controller.invalidate();
  });
  const seeded = await scene(page);
  expect(seeded.dirty).toBe(true); expect(seeded.summary).toMatchObject({ count: 5, visible: 4, selected: 1, canUndo: true, canRedo: true });
  expect(seeded.nativeRecords.reduce((count, chunk) => count + chunk.count, 0)).toBe(5);
  expect(seeded.nativeRecords).not.toEqual(original.nativeRecords); expect(seeded.nativeMasks).toHaveLength(5);
  expect(seeded.camera).not.toEqual(original.camera); expect(seeded.cameraBackground).toBe('gray');
  // Establish the exact Redo content before touching Settings, then restore
  // the retained endpoint that the preference interaction must preserve.
  expect(await page.evaluate(() => window.geometryViewer.controllerForSourceNavigation().command({ command: 'redo' }))).toBe(true);
  const redoOracle = await scene(page); expect(redoOracle.nativeRecords).not.toEqual(seeded.nativeRecords);
  expect(await page.evaluate(() => window.geometryViewer.controllerForSourceNavigation().command({ command: 'undo' }))).toBe(true);
  const before = await scene(page); expectSceneContent(before, seeded);

  const opener = page.getByRole('button', { name: 'Settings', exact: true });
  await opener.click();
  // No test refocusing before the first shortcut: opening Settings must move
  // focus itself. Synthetic body delivery separately exercises the state guard.
  await page.keyboard.press(`${primary}+z`);
  const immediate = await scene(page); expect(immediate).toEqual(before);
  await expect(page.getByRole('button', { name: 'Close Settings', exact: true })).toBeFocused();
  await page.evaluate(primary => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', ctrlKey: primary === 'Control', metaKey: primary === 'Meta', bubbles: true, cancelable: true }));
  }, primary);
  const outside = await scene(page); expect(outside).toEqual(before);
  const general = page.getByRole('tab', { name: 'General', exact: true });
  await page.keyboard.press('Tab'); await expect(general).toBeFocused();
  await page.keyboard.press('Tab'); await expect(page.getByRole('button', { name: 'Language', exact: true })).toBeFocused();
  await page.keyboard.press('Tab'); await expect(page.getByRole('button', { name: 'Theme', exact: true })).toBeFocused();
  await page.keyboard.press('Tab'); await expect(page.getByRole('button', { name: 'Font size', exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab'); await expect(page.getByRole('button', { name: 'Theme', exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab'); await expect(page.getByRole('button', { name: 'Language', exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab'); await expect(general).toBeFocused();
  await page.keyboard.press('Shift+Tab'); await expect(page.getByRole('button', { name: 'Close Settings', exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab'); await expect(page.getByRole('button', { name: 'Import view…', exact: true })).toBeFocused();
  await page.keyboard.press('Tab'); await expect(page.getByRole('button', { name: 'Close Settings', exact: true })).toBeFocused();
  const tabSnapshots: { interaction: string; tab: string; snapshot: Snapshot }[] = [];
  const checkTab = async (name: 'General' | 'Privacy' | 'Help', interaction: string) => {
    const tablist = page.getByRole('tablist', { name: 'Settings sections', exact: true });
    await expect(tablist.getByRole('tab')).toHaveCount(3);
    for (const label of ['General', 'Privacy', 'Help']) {
      const tab = tablist.getByRole('tab', { name: label, exact: true });
      await expect(tab).toHaveAttribute('aria-selected', String(label === name));
      await expect(tab).toHaveAttribute('tabindex', label === name ? '0' : '-1');
    }
    const selected = tablist.getByRole('tab', { name, exact: true }), panel = page.getByRole('tabpanel', { name, exact: true });
    await expect(page.getByRole('tabpanel')).toHaveCount(1);
    await expect(panel).toBeVisible();
    await expect(selected).toHaveAttribute('aria-controls', /.+/);
    await expect(panel).toHaveAttribute('aria-labelledby', /.+/);
    expect(await selected.getAttribute('aria-controls')).toBe(await panel.getAttribute('id'));
    expect(await panel.getAttribute('aria-labelledby')).toBe(await selected.getAttribute('id'));
    await expect(page.getByRole('button', { name: 'Font size', exact: true })).toHaveCount(name === 'General' ? 1 : 0);
    await page.keyboard.press(`${primary}+z`); await page.keyboard.press(`${primary}+Shift+z`);
    const snapshot = await scene(page); expect(snapshot).toEqual(before);
    tabSnapshots.push({ interaction, tab: name, snapshot });
  };
  await checkTab('General', 'opened');
  for (const name of ['Privacy', 'Help', 'General'] as const) {
    await page.getByRole('tab', { name, exact: true }).click();
    await checkTab(name, 'pointer');
  }
  await general.focus();
  for (const [key, name] of [['ArrowRight', 'Privacy'], ['ArrowRight', 'Help'], ['ArrowRight', 'General'],
    ['ArrowLeft', 'Help'], ['Home', 'General'], ['End', 'Help'], ['Home', 'General']] as const) {
    await page.keyboard.press(key);
    await expect(page.getByRole('tab', { name, exact: true })).toBeFocused();
    await checkTab(name, key);
  }
  const trigger = page.getByRole('button', { name: 'Font size', exact: true });
  await trigger.focus(); await page.keyboard.press('ArrowDown'); await page.keyboard.press('End');
  await expect(page.locator('main')).toHaveAttribute('data-ui-size', 'large');
  await page.keyboard.press('Tab'); await expect(page.getByRole('listbox', { name: 'Font size choices', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open folder', exact: true })).toBeFocused();
  await expect(page.locator('main')).toHaveAttribute('data-ui-size', 'small');
  const tabCanceled = await scene(page); expect(tabCanceled).toEqual(before);
  await trigger.click();
  let menu = page.getByRole('listbox', { name: 'Font size choices', exact: true });
  await menu.getByRole('option', { name: 'Large', exact: true }).hover();
  await expect(page.locator('main')).toHaveAttribute('data-ui-size', 'large');
  const preview = await scene(page); expect(preview).toEqual(before);
  expect(await page.evaluate(() => localStorage.getItem('splatview.ui-size.v1'))).toBeNull();
  await page.keyboard.press('Escape'); await expect(page.locator('main')).toHaveAttribute('data-ui-size', 'small');
  const canceled = await scene(page); expect(canceled).toEqual(before);
  await expect(trigger).toBeFocused(); await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toHaveCount(0); await expect(opener).toBeFocused();
  await opener.click();
  await trigger.click(); menu = page.getByRole('listbox', { name: 'Font size choices', exact: true });
  await menu.getByRole('option', { name: 'Large', exact: true }).click();
  await expect(page.locator('main')).toHaveAttribute('data-ui-size', 'large');
  expect(await page.evaluate(() => localStorage.getItem('splatview.ui-size.v1'))).toBe('large');
  const committed = await scene(page); expect(committed).toEqual(before);
  await page.getByRole('button', { name: 'Close Settings', exact: true }).click();
  await expect(opener).toBeFocused();
  await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  // Redo becomes disabled as soon as the command starts. Undo is enabled only
  // after the operation settles, so wait for that before capturing its result.
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeDisabled();
  const redone = await scene(page); expectSceneContent(redone, redoOracle);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
  const undone = await scene(page); expectSceneContent(undone, before);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await testInfo.attach('font-size-native-preservation.json', { body: JSON.stringify({ primary, platform: await page.evaluate(() => navigator.platform), original, before, immediate, outside, tabSnapshots, tabCanceled, preview, canceled, committed, redoOracle, redone, undone }), contentType: 'application/json' });
});
