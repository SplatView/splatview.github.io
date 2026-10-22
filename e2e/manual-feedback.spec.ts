import { expect, test, type Page } from '@playwright/test';
import type {} from './geometry-viewer-harness';
import { gaussianPly } from '../tests/fixtures/gaussians';
import { fixtureCenters } from './sceneCoordinates';
import { chooseSelectionTool } from './selectTool';

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });
const panel = (page: Page) => page.getByRole('complementary', { name: 'Tools', exact: true });
const option = (page: Page, name: string) => panel(page).getByRole('group', { name: 'Options', exact: true }).getByRole('button', { name, exact: true });
const finish = (page: Page) => page.getByRole('button', { name: 'Finalize selection', exact: true });
const clearSelection = (page: Page) => page.locator('.manual-selection-finish').getByRole('button', { name: 'Clear selection (C)', exact: true });
const copy = (page: Page) => page.getByRole('button', { name: 'Copy image', exact: true });
async function boot(page: Page, mode: 'basic' | 'pro' = 'basic') {
  await page.addInitScript(mode => localStorage.setItem('splatview.tools-mode.v1', mode), mode);
  await page.goto('/e2e/geometry-viewer-harness.html');
  await page.waitForFunction(() => !!window.geometryViewer?.ready());
  await page.getByLabel('Open scene files').setInputFiles({ name: 'manual-feedback-sh3.ply', mimeType: 'application/octet-stream', buffer: Buffer.from(gaussianPly()) });
  await expect(page).toHaveTitle('manual-feedback-sh3.ply — SplatView');
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
}
async function setOption(page: Page, name: string, pressed: boolean) {
  if (await option(page, name).getAttribute('aria-pressed') !== String(pressed)) await option(page, name).click();
  await expect(option(page, name)).toHaveAttribute('aria-pressed', String(pressed));
}
async function settled(page: Page) {
  await page.waitForFunction(() => {
    const app = window.geometryViewer.controllerForSourceNavigation();
    return !app.selectionActive && !document.querySelector('.status.panel');
  });
}
const snapshot = (page: Page) => page.evaluate(() => window.geometryViewer.selectionSnapshot());
function sceneState(value: Awaited<ReturnType<typeof snapshot>>) {
  const { selected, visible, count, shDegree, revision, contentRevision, canUndo, canRedo, selectionDraft } = value.summary;
  return { exported: value.exported, gpuMasks: value.gpuMasks, camera: value.camera, tool: value.tool, selectionActive: value.selectionActive,
    summary: { selected, visible, count, shDegree, revision, contentRevision, canUndo, canRedo, selectionDraft } };
}
async function triangle(page: Page, center: number[]) {
  let count = 0;
  for (const [dx, dy] of [[-24, -24], [24, -24], [0, 24]]) {
    const point = [center[0] + dx, center[1] + dy];
    // Raw mouse clicks have no locator actionability check. Observe the actual
    // coalesced release paint before the next press, rather than clicking a
    // floating control at its previous position between browser frames.
    await expect.poll(() => page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName, point)).toBe('CANVAS');
    await page.mouse.click(point[0], point[1]);
    await expect(panel(page).locator('.polygon-point-count')).toHaveText(`${++count} points`);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
  }
}

test('manual cursor, operation badges, brush trail and Volume ellipse use actual input without idle GPU/native queries', async ({ page }, info) => {
  await boot(page); await chooseSelectionTool(page, 'Brush'); await setOption(page, 'Live selection', false);
  const before = await snapshot(page), cursor = page.locator('[data-selection-cursor="brush"]'), overlay = page.locator('.manual-selection-feedback');
  await page.evaluate(() => {
    const app = window.geometryViewer.controllerForSourceNavigation(), renderer = app.renderer!, client = app.client!;
    const pick = renderer.pick, query = renderer.querySnapshot, command = client.command;
    const calls = { picks: 0, queries: 0, commands: [] as string[] };
    renderer.pick = function (...args) { calls.picks++; return pick.apply(this, args); };
    renderer.querySnapshot = function (...args) { calls.queries++; return query.apply(this, args); };
    client.command = function (...args) { calls.commands.push(args[0].command); return command.apply(this, args); };
    window.manualQueryProbe = { calls, restore() { renderer.pick = pick; renderer.querySnapshot = query; client.command = command; } };
  });
  await page.mouse.move(420, 420); await expect(cursor).toBeVisible();
  await expect(page.getByLabel('SplatView scene')).toHaveCSS('cursor', 'none');
  const radius = Number(await cursor.locator('[data-brush-radius]').getAttribute('r')); expect(radius).toBeGreaterThan(0);
  await page.keyboard.down('Alt'); await page.mouse.wheel(0, -100); await page.keyboard.up('Alt');
  await expect.poll(async () => Number(await cursor.locator('[data-brush-radius]').getAttribute('r'))).not.toBe(radius);
  await expect(page.locator('.manual-brush-hint')).toHaveText('Alt + scroll to change size');
  for (const [key, operation, badge, color] of [['1', '0', null, null], ['2', '1', 'Add', 'rgb(125 210 146)'],
    ['3', '2', 'Subtract', 'rgb(242 128 115)'], ['4', '3', 'Intersect', 'rgb(224 195 117)']] as const) {
    await page.getByLabel('SplatView scene').focus(); await page.keyboard.press(key);
    await expect(overlay).toHaveAttribute('data-selection-operation', operation);
    if (badge) {
      await expect(cursor.locator('[data-operation-badge]')).toHaveAttribute('data-operation-badge', badge);
      await expect(cursor.locator('circle').first()).toHaveAttribute('stroke', color!);
      await expect(cursor.locator('[data-operation-badge] .icon')).toHaveCSS('color', color!.replaceAll(' ', ', '));
    }
    else await expect(cursor.locator('[data-operation-badge]')).toHaveCount(0);
  }
  await page.keyboard.press('1'); await page.keyboard.down('Shift');
  await expect(cursor.locator('[data-operation-badge]')).toHaveAttribute('data-operation-badge', 'Add'); await page.keyboard.up('Shift');
  await expect(overlay).toHaveAttribute('data-selection-operation', '0');
  const calls = await page.evaluate(() => { const probe = window.manualQueryProbe!; probe.restore(); return probe.calls; });
  expect(calls).toEqual({ picks: 0, queries: 0, commands: [] });
  expect(sceneState(await snapshot(page))).toEqual(sceneState(before));
  await page.mouse.move(400, 420); await page.mouse.down(); await page.mouse.move(465, 455, { steps: 4 });
  await expect(overlay.locator('[data-brush-trail] polyline')).toBeVisible(); await expect(finish(page)).toHaveCount(0);
  await page.keyboard.press('Escape'); await page.mouse.up(); await settled(page);
  const cancelled = await snapshot(page); expect(cancelled.gpuMasks).toEqual(before.gpuMasks); expect(cancelled.exported).toBe(before.exported);
  expect(cancelled.summary.canUndo).toBe(false); expect(cancelled.tool).toBeNull();
  await chooseSelectionTool(page, 'Box select'); await setOption(page, 'Live selection', false);
  await page.getByRole('button', { name: 'Subtract', exact: true }).click();
  await page.mouse.move(400, 420); await page.mouse.down(); await page.mouse.move(465, 455);
  const box = overlay.locator('rect'); await expect(box).toHaveAttribute('width', '65'); await expect(box).toHaveAttribute('height', '35');
  await expect(box).toHaveAttribute('stroke', 'rgb(242 128 115)'); await expect(box).toHaveAttribute('fill-opacity', String(22 / 255));
  await expect(finish(page)).toHaveCount(0); await page.keyboard.press('Escape'); await page.mouse.up(); await settled(page);
  expect((await snapshot(page)).gpuMasks).toEqual(before.gpuMasks);
  await chooseSelectionTool(page, 'Volume brush'); await page.mouse.move(420, 420);
  const ellipse = page.locator('[data-volume-cursor] ellipse'), currentRadius = Number(await page.locator('[data-selection-cursor="volume"] [data-brush-radius]').getAttribute('r'));
  await expect(ellipse).toHaveAttribute('rx', String(currentRadius)); await expect(ellipse).toHaveAttribute('ry', String(currentRadius * .45));
  await expect(ellipse).toHaveAttribute('transform', 'rotate(60 420 420)');
  await page.mouse.move(1060, 150); await expect(page.locator('[data-volume-cursor]')).toHaveCount(0);
  await chooseSelectionTool(page, 'Single splat'); await page.mouse.move(420, 420);
  await expect(page.locator('[data-selection-cursor="single"] > path')).toBeVisible();
  await expect(page.locator('[data-selection-cursor="single"] circle')).toHaveAttribute('r', '3');
  await chooseSelectionTool(page, 'Color picker'); await page.mouse.move(420, 420);
  await expect(page.locator('[data-selection-cursor="color"] .manual-cursor-icon .icon')).toBeVisible();
  await expect(page.locator('[data-selection-cursor="color"] .manual-cursor-icon .icon')).toHaveCSS('color', 'rgb(242, 128, 115)');
  await chooseSelectionTool(page, 'Fill'); await page.mouse.move(420, 420);
  await expect(page.locator('[data-selection-cursor="fill"] .manual-cursor-icon .icon')).toBeVisible();
  await expect(page.locator('[data-selection-cursor="fill"] .manual-cursor-icon .icon')).toHaveCSS('color', 'rgb(242, 128, 115)');
  await info.attach('manual-feedback-idle-and-cancel.json', { contentType: 'application/json', body: JSON.stringify({ calls, before, cancelled }) });
});

// web-lite has one Tools profile (processing.advanced excludes Pro).
for (const mode of ['basic'] as const) {
  test(`${mode} Polygon buttons share native cancel/history and floating Finish/Exit semantics`, async ({ page }, info) => {
    // PLY import converts source Y/Z to the native viewer frame. The first two
    // source literals lie at zero; the third needs both signs changed.
    await boot(page, mode); const centers = await fixtureCenters(page, gaussianPly(), [[-.4, 0, 0], [.4, 0, 0], [0, -.4, -.1]]);
    await page.getByRole('button', { name: 'Select all', exact: true }).click(); await settled(page);
    const all = await snapshot(page); expect(all.gpuMasks).toEqual([1, 1, 1]);
    await chooseSelectionTool(page, 'Polygon'); await setOption(page, 'Include splat edges', false); await setOption(page, 'Live selection', true);
    await page.getByRole('button', { name: 'Replace', exact: true }).click();
    const polygon = panel(page).getByRole('group', { name: 'Polygon', exact: true });
    await expect(polygon.getByRole('button')).toHaveCount(3);
    for (const button of await polygon.getByRole('button').all()) await expect(button).toBeDisabled();
    await page.mouse.click(centers[0][0] - 24, centers[0][1] - 24);
    await expect(panel(page).locator('.polygon-point-count')).toHaveText('1 points'); await expect(finish(page)).toBeDisabled();
    await polygon.getByRole('button', { name: 'Previous point (Backspace)', exact: true }).click();
    await expect(panel(page).locator('.polygon-point-count')).toHaveText('0 points'); await settled(page);
    expect((await snapshot(page)).gpuMasks).toEqual(all.gpuMasks);
    await triangle(page, centers[0]); await page.mouse.click(centers[0][0] - 28, centers[0][1]);
    await expect(panel(page).locator('.polygon-point-count')).toHaveText('4 points');
    await polygon.getByRole('button', { name: 'Previous point (Backspace)', exact: true }).click();
    await expect(panel(page).locator('.polygon-point-count')).toHaveText('3 points');
    await polygon.getByRole('button', { name: 'Cancel polygon', exact: true }).click(); await settled(page);
    const cancelled = await snapshot(page); expect(cancelled.gpuMasks).toEqual(all.gpuMasks); expect(cancelled.tool).toBe('polygon');
    await page.getByRole('button', { name: 'Undo', exact: true }).click(); await settled(page);
    expect((await snapshot(page)).gpuMasks).toEqual([0, 0, 0]);
    await page.getByRole('button', { name: 'Redo', exact: true }).click(); await settled(page);
    expect((await snapshot(page)).gpuMasks).toEqual(all.gpuMasks);
    await triangle(page, centers[0]); await polygon.getByRole('button', { name: 'Close polygon (Enter)', exact: true }).click(); await settled(page);
    const closed = await snapshot(page); expect(closed.gpuMasks).toEqual([1, 0, 0]); expect(closed.tool).toBe('polygon');
    await expect(panel(page).locator('.polygon-point-count')).toHaveText('0 points');
    await page.getByRole('button', { name: 'Undo', exact: true }).click(); await settled(page); expect((await snapshot(page)).gpuMasks).toEqual(all.gpuMasks);
    await page.getByRole('button', { name: 'Redo', exact: true }).click(); await settled(page); expect((await snapshot(page)).gpuMasks).toEqual(closed.gpuMasks);
    await triangle(page, centers[2]); await finish(page).click(); await settled(page);
    const finished = await snapshot(page); expect(finished.gpuMasks).toEqual([0, 0, 1]); expect(finished.tool).toBeNull();
    await expect(finish(page)).toHaveCount(0); await expect(page.getByLabel('SplatView scene')).toBeFocused();
    await chooseSelectionTool(page, 'Polygon'); await triangle(page, centers[1]);
    // Controls appear beside the actual last release without covering it or chrome.
    const placement = await page.locator('.manual-selection-finish').evaluate((element, anchor) => {
      const box = element.getBoundingClientRect(), hitsAnchor = anchor[0] >= box.left && anchor[0] < box.right && anchor[1] >= box.top && anchor[1] < box.bottom;
      const overlaps = Array.from(document.querySelectorAll('.tools-panel,.toolbar')).some(control => { const other = control.getBoundingClientRect(); return box.left < other.right && box.right > other.left && box.top < other.bottom && box.bottom > other.top; });
      return { width: box.width, height: box.height, hitsAnchor, overlaps };
    }, [centers[1][0], centers[1][1] + 24]);
    expect(placement).toEqual({ width: 90, height: 28, hitsAnchor: false, overlaps: false });
    await clearSelection(page).click(); await settled(page); const exited = await snapshot(page);
    expect(exited.gpuMasks).toEqual([0, 0, 0]); expect(exited.tool).toBe('polygon'); expect(exited.summary.canRedo).toBe(false);
    for (const state of [cancelled, closed, finished, exited]) { expect(state.exported).toBe(all.exported); expect(state.camera).toEqual(all.camera); }
    await page.locator('.manual-selection-finish').getByRole('button', { name: 'Undo (Selection)', exact: true }).click(); await settled(page);
    expect((await snapshot(page)).gpuMasks).toEqual(finished.gpuMasks);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await info.attach('manual-polygon-actions-history.json', { contentType: 'application/json', body: JSON.stringify({ mode, all, cancelled, closed, finished, exited, placement }) });
  });
}

test('fullscreen caption, icon and pressed state follow real API exit events and the Exit button', async ({ page }) => {
  await boot(page);
  const enter = page.getByRole('button', { name: 'Fullscreen', exact: true }); await expect(enter).toHaveAttribute('aria-pressed', 'false');
  const enterIcon = await enter.locator('.icon').innerHTML(); await enter.click();
  await page.waitForFunction(() => !!document.fullscreenElement);
  const leave = page.getByRole('button', { name: 'Exit fullscreen', exact: true }); await expect(leave).toHaveAttribute('aria-pressed', 'true');
  expect(await leave.locator('.icon').innerHTML()).not.toBe(enterIcon);
  // Headless Chromium does not deliver a host Escape fullscreen exit. Invoke
  // the real browser exit API and observe its genuine fullscreenchange event.
  await page.evaluate(() => document.exitFullscreen()); await page.waitForFunction(() => !document.fullscreenElement);
  await expect(enter).toHaveAttribute('aria-pressed', 'false'); expect(await enter.locator('.icon').innerHTML()).toBe(enterIcon);
  await enter.click(); await expect(leave).toBeVisible(); await leave.click();
  await page.waitForFunction(() => !document.fullscreenElement); await expect(enter).toHaveAttribute('aria-pressed', 'false');
});

type ClipboardProbe = { calls: number; synchronous: boolean; trusted: boolean; nativeSettled: boolean; returned: boolean; release(): void; restore(): void };
declare global { interface Window {
  manualClipboardProbe?: ClipboardProbe;
  manualQueryProbe?: { calls: { picks: number; queries: number; commands: string[] }; restore(): void };
} }
async function holdActualClipboard(page: Page) {
  await page.evaluate(() => {
    const button = document.querySelector<HTMLButtonElement>('[aria-label="Copy image"]')!, write = navigator.clipboard.write.bind(navigator.clipboard);
    const app = window.geometryViewer.controllerForSourceNavigation(), originalCopy = app.copyImage;
    let release!: () => void, inClick = false, inCopy = false, trusted = false;
    const held = new Promise<void>(resolve => { release = resolve; });
    const capture = (event: MouseEvent) => { if (button.contains(event.target as Node)) { inClick = true; trusted = event.isTrusted; } };
    const finishClick = () => { inClick = false; };
    document.addEventListener('click', capture, true); window.addEventListener('click', finishClick);
    app.copyImage = () => { inCopy = true; try { return originalCopy.call(app); } finally { inCopy = false; } };
    const probe: ClipboardProbe = { calls: 0, synchronous: false, trusted: false, nativeSettled: false, returned: false, release,
      restore() { release(); navigator.clipboard.write = write; app.copyImage = originalCopy;
        document.removeEventListener('click', capture, true); window.removeEventListener('click', finishClick); } };
    navigator.clipboard.write = async items => {
      probe.calls++; probe.synchronous = inClick && inCopy; probe.trusted = trusted;
      await write(items); probe.nativeSettled = true; await held; probe.returned = true;
    };
    window.manualClipboardProbe = probe;
  });
}

test('Copy confirms for three seconds only after real PNG encoding and trusted clipboard write have joined', async ({ page }, info) => {
  await boot(page); const before = await snapshot(page); await holdActualClipboard(page);
  try {
    await copy(page).click(); await page.waitForFunction(() => window.manualClipboardProbe?.nativeSettled);
    await expect(copy(page)).toHaveAttribute('aria-pressed', 'false'); await expect(copy(page)).toHaveAttribute('title', 'Copy view to clipboard (Ctrl+C)');
    const written = await page.evaluate(async () => {
      const probe = window.manualClipboardProbe!, items = await navigator.clipboard.read();
      const blob = await items.find(item => item.types.includes('image/png'))!.getType('image/png'), bitmap = await createImageBitmap(blob);
      try { return { calls: probe.calls, synchronous: probe.synchronous, trusted: probe.trusted, nativeSettled: probe.nativeSettled, returned: probe.returned,
        type: blob.type, width: bitmap.width, height: bitmap.height, bytes: blob.size }; } finally { bitmap.close(); }
    });
    expect(written).toMatchObject({ calls: 1, synchronous: true, trusted: true, nativeSettled: true, returned: false, type: 'image/png', width: 1280, height: 800 }); expect(written.bytes).toBeGreaterThan(0);
    await page.evaluate(() => window.manualClipboardProbe!.release()); await expect(copy(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(copy(page)).toHaveAttribute('title', 'Copied view to clipboard'); await expect(page.getByRole('status', { name: 'Copy image', exact: true })).toHaveText('Copied view to clipboard');
    await page.waitForTimeout(2000); await expect(copy(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(copy(page)).toHaveAttribute('aria-pressed', 'false', { timeout: 2500 });
    await expect(page.getByRole('status', { name: 'Copy image', exact: true })).toBeEmpty();
    expect(sceneState(await snapshot(page))).toEqual(sceneState(before));
    await info.attach('manual-copy-actual-clipboard.json', { contentType: 'application/json', body: JSON.stringify(written) });
  } finally { await page.evaluate(() => window.manualClipboardProbe?.restore()); }
});

test('Close during a real completed but unjoined clipboard write cannot show late Copy confirmation', async ({ page }) => {
  await boot(page); await holdActualClipboard(page);
  try {
    await copy(page).click(); await page.waitForFunction(() => window.manualClipboardProbe?.nativeSettled);
    await page.evaluate(() => { void window.geometryViewer.controllerForSourceNavigation().closeScene(); });
    await expect(copy(page)).toBeDisabled(); await expect(copy(page)).toHaveAttribute('aria-pressed', 'false');
    await page.evaluate(() => window.manualClipboardProbe!.release());
    await page.waitForFunction(() => !window.geometryViewer.controllerForSourceNavigation().client);
    await expect(copy(page)).toHaveAttribute('aria-pressed', 'false'); await expect(page.getByRole('status', { name: 'Copy image', exact: true })).toBeEmpty();
    await expect(page.getByRole('alert')).toHaveCount(0);
  } finally { await page.evaluate(() => window.manualClipboardProbe?.restore()); }
});

test('actual browser clipboard policy denial reports its failure without a Copy success receipt', async ({ page }, info) => {
  await page.route('**/e2e/geometry-viewer-harness.html', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), 'Permissions-Policy': 'clipboard-write=()' } });
  });
  await boot(page); const before = await snapshot(page);
  const denied = await page.evaluate(async () => ({
    policyAllowed: (document as Document & { featurePolicy: { allowsFeature(name: string): boolean } }).featurePolicy.allowsFeature('clipboard-write'),
    permission: (await navigator.permissions.query({ name: 'clipboard-write' as PermissionName })).state,
  }));
  // The context grants clipboard permission; the document's separate policy
  // still blocks actual writes. Permissions API state is diagnostic here.
  expect(denied.policyAllowed).toBe(false);
  await copy(page).click(); await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('alert')).toContainText(/clipboard|permission|write/i);
  await expect(copy(page)).toHaveAttribute('aria-pressed', 'false'); await expect(page.getByRole('status', { name: 'Copy image', exact: true })).toBeEmpty();
  const after = await snapshot(page); expect(after.exported).toBe(before.exported); expect(after.gpuMasks).toEqual(before.gpuMasks); expect(after.summary).toEqual(before.summary);
  await info.attach('manual-copy-document-policy.json', { contentType: 'application/json', body: JSON.stringify(denied) });
});
