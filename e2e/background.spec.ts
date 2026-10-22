import { expect, test } from '@playwright/test';
import { queuePly } from './queue-fixture';
import type {} from './background-harness';

test.describe('Desktop Background through real native/WebGPU', () => {
  test.beforeEach(async ({ page }) => { await page.goto('/e2e/background-harness.html'); await page.waitForFunction(() => Boolean(window.backgroundHarness)); });
  test('display, empty framebuffer and clean capture use all three linear shades', async ({ page }) => {
    const result = await page.evaluate(() => window.backgroundHarness.tones());
    expect(result.statePreserved).toBe(true); expect(result.revisionPreserved).toBe(true);
    expect(result.tones.map(tone => tone.color)).toEqual(['black', 'gray', 'white']);
    for (const tone of result.tones) {
      // Independent premultiplied back-to-front oracle: B*.6 + R*.4*.4
      // plus the uncovered background fraction .6*.4. Quantized SH halves
      // and the unorm8 blend target permit a two-byte channel tolerance.
      const expectedCenter = [.1 * .6 + .8 * .4 * .4, .4 * .6 + .2 * .4 * .4, .8 * .6 + .1 * .4 * .4].map(value => (value + tone.shade * .6 * .4) * 255);
      for (const image of [tone.display, tone.capture]) {
        expect(image.width).toBe(321); expect(image.height).toBe(241);
        image.corner.slice(0, 3).forEach(channel => expect(Math.abs(channel - tone.shade * 255)).toBeLessThanOrEqual(1));
        image.center.slice(0, 3).forEach((channel, i) => expect(Math.abs(channel - expectedCenter[i])).toBeLessThanOrEqual(2));
        expect(image.corner[3]).toBe(255); expect(image.center[3]).toBe(255);
      }
      expect(tone.display).toEqual(tone.capture);
      for (const pixel of [tone.empty.corner, tone.empty.center]) {
        pixel.slice(0, 3).forEach(channel => expect(Math.abs(channel - tone.shade * 255)).toBeLessThanOrEqual(1)); expect(pixel[3]).toBe(255);
      }
    }
  });
  for (const tool of ['color', 'fill'] as const) {
    test(`${tool} completed owner and retained raw map survive background cycles without GPU readback`, async ({ page }) => {
      const result = await page.evaluate(tool => window.backgroundHarness.owner(tool), tool);
      expect(result.accepted).toBe(true); expect(result.cycles).toEqual(['gray', 'white', 'black']);
      expect(result.before.masks).toEqual([1, 0, 0, 0, 0]); expect(result.before.ids).toEqual([0]); expect(result.before.summary.selected).toBe(1);
      expect(result.afterCycle).toEqual(result.before.summary); expect(result.sameOutput).toBe(true);
      expect(result.sameMap).toBe(true); expect(result.frameRevisionPreserved).toBe(true); expect(result.sortRevisionPreserved).toBe(true);
      expect(result.sorts).toBe(0); expect(result.sourceWrites).toBe(0);
      expect(result.queryReadbacks).toBe(0); expect(result.queryPicks).toBe(0);
      expect(result.amended.masks).toEqual([1, 1, 1, 0, 0]); expect(result.amended.ids).toEqual([0, 1, 2]); expect(result.amended.summary.selected).toBe(3);
      expect(result.amended.summary.toleranceSessionId).toBe(result.before.summary.toleranceSessionId);
      expect(result.amended.summary.toleranceMapId).toBe(result.before.summary.toleranceMapId);
      expect(result.amended.dirty).toBe(false); expect(result.amended.cameraRevision).toBe(result.before.cameraRevision);
      expect(result.undone.masks).toEqual([0, 0, 0, 0, 0]); expect(result.undone.ids).toEqual([]); expect(result.undone.exportError).toMatch(/There are no visible Gaussians to save/); expect(result.undone.summary.canUndo).toBe(false);
      expect(result.redone.masks).toEqual([1, 1, 1, 0, 0]); expect(result.redone.ids).toEqual([0, 1, 2]); expect(result.error).toBeNull();
    });
    test(`${tool} pending genuine surface query remains valid across a background-only render`, async ({ page }) => {
      const result = await page.evaluate(tool => window.backgroundHarness.pending(tool), tool);
      expect(result.pending).toBe(1); expect(result.accepted).toBe(true); expect(result.revisionPreserved).toBe(true);
      expect(result.after.masks).toEqual([1, 0, 0, 0, 0]); expect(result.after.ids).toEqual([0]); expect(result.after.summary.selected).toBe(1);
      expect(result.after.background).toBe('gray'); expect(result.after.storeBackground).toBe('gray'); expect(result.after.dirty).toBe(false);
      expect(result.error).toBeNull();
    });
  }
  test('background changes preserve a completed Color owner waiting for its first Connected RGB map', async ({ page }) => {
    const result = await page.evaluate(() => window.backgroundHarness.waitingConnected());
    expect(result.before.ids).toEqual([0, 3]); expect(result.before.masks).toEqual([1, 0, 0, 1, 0]);
    expect(result.waiting.ids).toEqual(result.before.ids); expect(result.waiting.masks).toEqual(result.before.masks);
    expect(result.waiting.background).toBe('white'); expect(result.waiting.storeBackground).toBe('white');
    expect(result.waiting.summary.toleranceSessionId).toBe(result.before.summary.toleranceSessionId);
    expect(result.connected.ids).toEqual([0]); expect(result.connected.masks).toEqual([1, 0, 0, 0, 0]);
    expect(result.connected.summary.toleranceSessionId).toBe(result.before.summary.toleranceSessionId);
    expect(result.connected.summary.toleranceConnected).toBe(true); expect(result.preference).toBe(true);
    expect(result.amended.ids).toEqual([0, 1, 2]); expect(result.amended.masks).toEqual([1, 1, 1, 0, 0]);
    expect(result.amended.summary.toleranceMapId).toBe(result.connected.summary.toleranceMapId);
    expect(result.requests).toBe(1); expect(result.amended.dirty).toBe(false); expect(result.error).toBeNull();
  });
  for (const failed of [false, true]) test(`${failed ? 'refused' : 'successful'} source replacement ${failed ? 'preserves the old' : 'resets the'} background`, async ({ page }) => {
    const result = await page.evaluate(failed => window.backgroundHarness.replacement(failed), failed);
    expect(result.before.background).toBe('white'); expect(result.before.storeBackground).toBe('white'); expect(result.before.masks).toEqual([0, 0, 0, 1, 0]);
    expect(result.sameClient).toBe(failed); expect(result.after.background).toBe(failed ? 'white' : 'black'); expect(result.after.storeBackground).toBe(result.after.background);
    expect(result.after.dirty).toBe(false);
    if (failed) { expect(result.after.summary).toEqual(result.before.summary); expect(result.after.masks).toEqual(result.before.masks); expect(result.sourceName).toBe('background-sh0.ply'); expect(result.error).toBeTruthy(); }
    else { expect(result.after.masks).toEqual([0, 0, 0, 0, 0]); expect(result.sourceName).toBe('replacement.ply'); expect(result.error).toBeNull(); }
  });
  test('Reset camera restores black without editing content, masks or history', async ({ page }) => {
    const result = await page.evaluate(() => window.backgroundHarness.reset());
    expect(result.before.background).toBe('white'); expect(result.after.background).toBe('black'); expect(result.after.storeBackground).toBe('black');
    expect(result.after.masks).toEqual(result.before.masks); expect(result.after.summary).toEqual(result.before.summary);
    expect(result.after.dirty).toBe(false); expect(result.after.state).not.toEqual(result.before.state); expect(result.error).toBeNull();
  });
  test('graphics recovery retains background, view, masks and history on a new GPU epoch', async ({ page }) => {
    const result = await page.evaluate(() => window.backgroundHarness.recovery());
    expect(result.recovered).toBe(true); expect(result.changedEpoch).toBe(true); expect(result.busy).toBe(false); expect(result.error).toBeNull();
    expect(result.after.background).toBe('white'); expect(result.after.storeBackground).toBe('white'); expect(result.after.state).toEqual(result.before.state);
    expect(result.after.masks).toEqual(result.before.masks); expect(result.after.summary.contentRevision).toBe(result.before.summary.contentRevision);
    expect(result.after.summary.canUndo).toBe(result.before.summary.canUndo); expect(result.after.summary.canRedo).toBe(result.before.summary.canRedo);
    expect(result.after.dirty).toBe(result.before.dirty); expect(result.afterImage).toEqual(result.beforeImage); expect(result.afterImage.corner).toEqual([255, 255, 255, 255]);
  });
});

test('Background ends the View navigation group and cycles the desktop tones', async ({ page }) => {
  await page.goto('/'); const background = page.getByRole('button', { name: 'Background', exact: true });
  await expect(background).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Open scene', exact: true })).toBeEnabled();
  await page.getByLabel('Open scene files').setInputFiles({ name: 'background-toolbar.ply', mimeType: 'application/octet-stream', buffer: Buffer.from(queuePly()) });
  await expect(background).toBeEnabled();
  await page.mouse.move(640, 400); await expect(page.locator('main')).not.toHaveClass(/chrome-hidden/);
  const navigation = page.getByRole('group', { name: 'View navigation', exact: true });
  expect(await navigation.getByRole('button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label'))))
    .toEqual(['Reset camera', 'Orbit / Look', 'Auto orbit', 'Flip up', 'Viewport guides', 'Background']);
  await expect(navigation.getByRole('button', { name: 'Background', exact: true })).toHaveCount(1);
  const swatch = background.locator('svg rect');
  await expect(swatch).toHaveCount(1); await expect(background.locator('circle')).toHaveCount(0);
  await expect(swatch).toHaveAttribute('width', '14'); await expect(swatch).toHaveAttribute('height', '14'); await expect(swatch).toHaveAttribute('rx', '2');
  for (const [tone, next, fill] of [['black', 'gray', '#000'], ['gray', 'white', '#808080'], ['white', 'black', '#fff']] as const) {
    await expect(background).toHaveAttribute('data-background', tone); await expect(background).toHaveAttribute('title', `${tone[0].toUpperCase() + tone.slice(1)} background. Click for ${next}.`);
    await expect(swatch).toHaveAttribute('fill', fill); await background.click();
  }
  await expect(background).toHaveAttribute('data-background', 'black'); await expect(swatch).toHaveAttribute('fill', '#000'); await background.click();
  await page.getByRole('button', { name: 'Reset camera', exact: true }).click(); await expect(background).toHaveAttribute('data-background', 'black');
});

test('Remember view in Settings saves the actual App view and restores it through Reset and a renamed reopen', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Open scene', exact: true })).toBeEnabled();
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase('splatview-views');
    request.onsuccess = () => resolve(); request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Saved-view storage is blocked.'));
  }));
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  const remember = settings.getByRole('button', { name: 'Remember view', exact: true });
  const background = page.getByRole('button', { name: 'Background', exact: true });
  const input = { name: 'saved-toolbar.ply', mimeType: 'application/octet-stream', buffer: Buffer.from(queuePly()) };
  await page.getByLabel('Open scene files').setInputFiles(input);
  await expect(background).toBeEnabled(); await page.mouse.move(640, 400);
  await expect(page.locator('main')).not.toHaveClass(/chrome-hidden/);
  await background.click(); await expect(background).toHaveAttribute('data-background', 'gray');
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(remember).toBeEnabled(); await remember.click();
  await expect(settings.getByRole('status').filter({ hasText: 'Thumbnail and default view saved in this browser.' }))
    .toHaveText('Thumbnail and default view saved in this browser.');
  await expect(remember).toBeEnabled();
  await settings.getByRole('button', { name: 'Close Settings', exact: true }).click();
  await background.click(); await expect(background).toHaveAttribute('data-background', 'white');
  await page.getByRole('button', { name: 'Reset camera', exact: true }).click();
  await expect(background).toHaveAttribute('data-background', 'gray');
  await background.click(); await expect(background).toHaveAttribute('data-background', 'white');
  await page.getByLabel('Open scene files').setInputFiles({ ...input, name: 'renamed-toolbar-copy.ply' });
  await expect(page).toHaveTitle('renamed-toolbar-copy.ply — SplatView');
  await expect(background).toHaveAttribute('data-background', 'gray');
  await page.reload(); await expect(page.getByRole('button', { name: 'Open scene', exact: true })).toBeEnabled();
  await page.getByLabel('Open scene files').setInputFiles({ ...input, name: 'reloaded-copy.ply' });
  await expect(page).toHaveTitle('reloaded-copy.ply — SplatView');
  await expect(background).toHaveAttribute('data-background', 'gray');
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(remember).toBeEnabled();
});

test('saved-view chooser traps focus and blocks scene shortcuts until an explicit App choice', async ({ page }) => {
  await page.goto('/e2e/saved-view-harness.html'); await page.waitForFunction(() => !!window.savedViewHarness);
  // Use the exact fixture bytes that seeded the records. Node and Chromium's
  // Math.log can differ in the final decimal digit; content identity must not.
  const bytes = await page.evaluate(async () => {
    const url = '/e2e/queue-fixture.ts'; const fixture = await import(url);
    return Array.from(fixture.queuePly()) as number[];
  });
  const seeded = await page.evaluate(() => window.savedViewHarness.ambiguity());
  expect(seeded.choices).toEqual(['gray', 'white']);
  await page.goto('/'); await expect(page.getByRole('button', { name: 'Open scene', exact: true })).toBeEnabled();
  await page.getByLabel('Open scene files').setInputFiles({ name: 'chooser-app.ply', mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) });
  const chooser = page.getByRole('dialog', { name: 'Choose saved view', exact: true });
  await expect(chooser).toBeVisible();
  const first = chooser.getByRole('button').first(), initial = chooser.getByRole('button', { name: 'Use initial view', exact: true });
  await expect(first).toBeFocused(); await page.keyboard.press('Shift+Tab'); await expect(initial).toBeFocused();
  await page.keyboard.press('Tab'); await expect(first).toBeFocused();
  await page.keyboard.press('ControlOrMeta+s');
  await expect(chooser).toBeVisible(); await expect(page.getByRole('dialog', { name: 'Save scene', exact: true })).toHaveCount(0);
  await chooser.getByRole('button', { name: /Other saved copy/ }).click(); await expect(chooser).toHaveCount(0);
  const background = page.getByRole('button', { name: 'Background', exact: true });
  await expect(background).toHaveAttribute('data-background', 'gray');
  await page.mouse.move(640, 400); await expect(page.locator('main')).not.toHaveClass(/chrome-hidden/);
  await background.click(); await page.getByRole('button', { name: 'Reset camera', exact: true }).click();
  await expect(background).toHaveAttribute('data-background', 'gray');
});

test('Escape dismisses the actual App saved-view chooser, keeps initial background and restores toolbar focus', async ({ page }) => {
  await page.goto('/e2e/saved-view-harness.html'); await page.waitForFunction(() => !!window.savedViewHarness);
  const bytes = await page.evaluate(async () => {
    const url = '/e2e/queue-fixture.ts'; return Array.from((await import(url)).queuePly()) as number[];
  });
  expect((await page.evaluate(() => window.savedViewHarness.ambiguity())).choices).toEqual(['gray', 'white']);
  await page.goto('/');
  const open = page.getByRole('button', { name: 'Open scene', exact: true }); await expect(open).toBeEnabled(); await open.focus();
  await page.getByLabel('Open scene files').setInputFiles({ name: 'escape-chooser.ply', mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) });
  const chooser = page.getByRole('dialog', { name: 'Choose saved view', exact: true }); await expect(chooser).toBeVisible();
  await expect(chooser.getByRole('button').first()).toBeFocused();
  const before = await page.evaluate(async () => {
    const url = '/src/app/store.ts'; const state = (await import(url)).useApp.getState();
    return { summary: state.summary, dirty: state.dirty, sourceName: state.sourceName };
  });
  await page.keyboard.press('Escape'); await expect(chooser).toHaveCount(0); await expect(open).toBeFocused();
  await expect(page.getByRole('button', { name: 'Background', exact: true })).toHaveAttribute('data-background', 'black');
  expect(await page.evaluate(async () => {
    const url = '/src/app/store.ts'; const state = (await import(url)).useApp.getState();
    return { summary: state.summary, dirty: state.dirty, sourceName: state.sourceName };
  })).toEqual(before);
  const save = page.getByRole('dialog', { name: 'Save scene', exact: true });
  await page.keyboard.press('ControlOrMeta+s'); await expect(save).toHaveCount(0); await expect(open).toBeFocused();
  const viewport = page.getByLabel('SplatView scene', { exact: true }); await viewport.focus(); await expect(viewport).toBeFocused();
  await page.keyboard.press('ControlOrMeta+s'); await expect(save).toBeVisible();
  await save.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(save).toHaveCount(0);
});
