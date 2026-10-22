import { expect, test, type Download, type Page } from '@playwright/test';
import type {} from './toolbar-feedback-harness';

const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const scene = (page: Page) => page.getByLabel('SplatView scene', { exact: true });
const state = (page: Page) => page.evaluate(() => window.toolbarFeedbackHarness.state());
const snapshot = (page: Page) => page.evaluate(() => window.toolbarFeedbackHarness.snapshot());
type Snapshot = Awaited<ReturnType<Window['toolbarFeedbackHarness']['snapshot']>>;
function retained(actual: Snapshot, before: Snapshot) {
  expect(actual.records).toEqual(before.records); expect(actual.gpuRecords).toEqual(before.gpuRecords);
  expect(actual.masks).toEqual(before.masks); expect(actual.gpuMasks).toEqual(before.gpuMasks);
  for (const key of ['revision', 'contentRevision', 'canUndo', 'canRedo'] as const) expect(actual.summary[key]).toBe(before.summary[key]);
  expect(actual.document).toEqual(before.document); expect(actual.sourceFingerprint).toEqual(before.sourceFingerprint);
  expect(actual.camera).toEqual(before.camera);
}
async function boot(page: Page, mode: 'basic' | 'pro' = 'basic') {
  await page.addInitScript(value => localStorage.setItem('splatview.tools-mode.v1', value), mode);
  await page.goto('/e2e/toolbar-feedback-harness.html');
  await page.waitForFunction(() => window.geometryViewerError || window.toolbarFeedbackHarness?.ready());
  expect(await page.evaluate(() => window.geometryViewerError)).toBeUndefined();
  await page.evaluate(() => window.toolbarFeedbackHarness.load());
  if (!(await page.evaluate(() => window.opacityHarness.state())).toolsOpen) await button(page, 'Tools').click();
}
async function openRememberView(page: Page) {
  await page.mouse.move(8, 300); await page.mouse.move(9, 300);
  const tools = page.getByRole('complementary', { name: 'Tools', exact: true });
  if (!await tools.isVisible()) await button(page, 'Tools').click();
  await tools.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.getByRole('tab', { name: 'General', exact: true }).click();
  return settings.getByRole('button', { name: 'Remember view', exact: true });
}
test.afterEach(async ({ page }) => { await page.evaluate(() => window.toolbarFeedbackHarness?.stop()); });

test('Capture confirms for three seconds only after the genuine JPEG download handoff', async ({ page }, info) => {
  await boot(page); const before = await snapshot(page); await page.evaluate(() => window.toolbarFeedbackHarness.holdEncoding());
  try {
    await button(page, 'Capture image').click(); await expect.poll(async () => (await state(page)).encoded).not.toBeNull();
    const held = await state(page); expect(held.encoded).toMatchObject({ type: 'image/jpeg', width: 1280, height: 800 });
    expect(held.encoded!.bytes).toBeGreaterThan(0); expect(held.image.bytes).toBeGreaterThan(0);
    await expect(button(page, 'Capture image')).toHaveAttribute('aria-pressed', 'false');
    const download = page.waitForEvent('download'); await page.evaluate(() => window.toolbarFeedbackHarness.releaseEncoding());
    expect((await download).suggestedFilename()).toBe('SplatView.jpg');
    await expect(button(page, 'Capture image')).toHaveAttribute('aria-pressed', 'true');
    await expect(button(page, 'Capture image')).toHaveAttribute('title', 'Download prepared');
    await page.waitForTimeout(2000); await expect(button(page, 'Capture image')).toHaveAttribute('aria-pressed', 'true');
    await expect(button(page, 'Capture image')).toHaveAttribute('aria-pressed', 'false', { timeout: 2500 });
    retained(await snapshot(page), before);
    await info.attach('capture-genuine-jpeg-held.json', { contentType: 'application/json', body: JSON.stringify(held) });
  } finally { await page.evaluate(() => window.toolbarFeedbackHarness.finishEncoding()); }
});

test('a failed new Capture clears prior success and keeps native bytes, masks and history', async ({ page }) => {
  await boot(page); const before = await snapshot(page);
  const download = page.waitForEvent('download'); await page.evaluate(() => window.geometryViewer.controllerForSourceNavigation().snapshot()); await download;
  await expect(button(page, 'Capture image')).toHaveAttribute('aria-pressed', 'true');
  await page.evaluate(() => window.toolbarFeedbackHarness.holdEncoding('deny'));
  try {
    await button(page, 'Capture image').click(); await expect(page.getByRole('alert')).toContainText('image adapter refused');
    await expect(button(page, 'Capture image')).toHaveAttribute('aria-pressed', 'false');
    expect((await state(page)).encoded?.type).toBe('image/jpeg'); retained(await snapshot(page), before);
  } finally { await page.evaluate(() => window.toolbarFeedbackHarness.finishEncoding()); }
});

test('Close joins a held genuine Capture and cannot publish a stale result or retain its image owners', async ({ page }, info) => {
  await boot(page); const baseline = (await state(page)).image; await page.evaluate(() => window.toolbarFeedbackHarness.holdEncoding());
  const downloads: string[] = [], observeDownload = (download: Download) => { downloads.push(download.suggestedFilename()); };
  page.on('download', observeDownload);
  try {
    await button(page, 'Capture image').click(); await expect.poll(async () => (await state(page)).encoded).not.toBeNull();
    const held = await state(page); await page.evaluate(() => window.toolbarFeedbackHarness.beginClose());
    await expect(button(page, 'Capture image')).toHaveAttribute('aria-pressed', 'false');
    expect((await state(page)).close).toEqual({ started: true, settled: false }); expect(downloads).toEqual([]);
    expect((await state(page)).image.bytes).toBeGreaterThan(baseline.bytes);
    await page.evaluate(() => window.toolbarFeedbackHarness.releaseEncoding());
    await page.evaluate(() => window.toolbarFeedbackHarness.joinClose());
    expect(await state(page)).toMatchObject({ hasScene: false, close: { started: true, settled: true } });
    await expect.poll(async () => (await state(page)).image).toEqual(baseline);
    expect((await state(page)).feedback.capture).toBeNull(); await expect(page.getByRole('alert')).toHaveCount(0);
    expect(downloads).toEqual([]);
    await info.attach('capture-close-held-owner.json', { contentType: 'application/json', body: JSON.stringify({ baseline, held, final: await state(page), downloads }) });
  } finally {
    try { await page.evaluate(async () => { await window.toolbarFeedbackHarness.finishEncoding(); await window.toolbarFeedbackHarness.joinClose(); }); }
    finally { page.off('download', observeDownload); }
  }
});

test('Save shortcut and direct controller downloads confirm preparation without clearing dirty before kept-file acknowledgement', async ({ page }, info) => {
  await boot(page);
  expect(await page.evaluate(() => window.opacityHarness.command({ command: 'single', index: 2, operation: 0 }))).toBe(true);
  expect(await page.evaluate(() => window.opacityHarness.command({ command: 'delete' }))).toBe(true);
  const before = await snapshot(page); expect((await state(page)).dirty).toBe(true);
  await scene(page).focus(); await page.keyboard.press('ControlOrMeta+s');
  const dialog = page.getByRole('dialog', { name: 'Save scene', exact: true }); await expect(dialog).toBeVisible();
  let download = page.waitForEvent('download'); await dialog.getByRole('button', { name: 'Download', exact: true }).click();
  expect((await download).suggestedFilename()).toMatch(/\.ply$/);
  await expect(button(page, 'Save scene')).toHaveAttribute('aria-pressed', 'true'); await expect(button(page, 'Save scene')).toHaveAttribute('title', 'Download prepared');
  expect(await state(page)).toMatchObject({ dirty: true, outputPending: true }); retained(await snapshot(page), before);
  await button(page, 'I have kept the file').click(); await expect.poll(async () => (await state(page)).dirty).toBe(false);
  download = page.waitForEvent('download'); await page.evaluate(() => window.geometryViewer.controllerForSourceNavigation().exportScene(0, 0)); await download;
  await expect(button(page, 'Save scene')).toHaveAttribute('aria-pressed', 'true');
  retained(await snapshot(page), before); await button(page, 'I have kept the file').click();
  await info.attach('save-prepared-current-document.json', { contentType: 'application/json', body: JSON.stringify(await state(page)) });
});

test('T and Remember view confirm only a genuine saved pair and an aborted browser transaction clears success', async ({ page }, info) => {
  await boot(page); const before = await snapshot(page);
  await scene(page).focus(); await page.keyboard.press('t');
  // Let the viewport-owned shortcut finish before opening Settings to inspect
  // its relocated feedback. The modal must never manufacture T's focus state.
  await expect.poll(() => state(page)).toMatchObject({ thumbnailPending: false,
    feedback: { thumbnail: { message: 'Thumbnail and default view saved in this browser.' } } });
  const remember = await openRememberView(page);
  await expect(remember).toHaveAttribute('aria-pressed', 'true');
  await expect(remember).toHaveAttribute('title', 'Thumbnail and default view saved in this browser.');
  const pair = await page.evaluate(() => window.toolbarFeedbackHarness.savedPair()); expect(pair).toHaveLength(1);
  expect(pair[0].imageRecordId).toBe(pair[0].record.recordId); expect(pair[0].sha256).toBe(pair[0].record.thumbnail.sha256);
  expect(pair[0]).toMatchObject({ type: 'image/png', width: 800, height: 800 }); expect(pair[0].bytes).toBeGreaterThan(0);
  retained(await snapshot(page), before);
  await page.evaluate(() => window.toolbarFeedbackHarness.abortNextThumbnailWrite());
  try {
    await remember.click();
    await expect.poll(async () => (await state(page)).thumbnailPending).toBe(false);
    await expect(remember).toHaveAttribute('aria-pressed', 'false');
    expect((await state(page)).viewStatus).toMatch(/could not|abort|transaction/i);
    expect(await page.evaluate(() => window.toolbarFeedbackHarness.savedPair())).toEqual(pair);
  } finally { await page.evaluate(() => window.toolbarFeedbackHarness.restoreStorage()); }
  await button(page, 'Close Settings').click();
  retained(await snapshot(page), before);
  await info.attach('thumbnail-actual-saved-pair.json', { contentType: 'application/json', body: JSON.stringify(pair) });
});

for (const mode of ['basic', 'pro'] as const) test(`${mode} plain-control Escape returns viewport focus before a fresh Escape cancels the tool`, async ({ page }) => {
  await boot(page, mode); await scene(page).focus(); await page.keyboard.press('b');
  await expect.poll(() => page.evaluate(() => window.opacityHarness.state().tool)).toBe('brush');
  const before = await snapshot(page); await page.evaluate(() => window.opacityHarness.observe());
  const tools = button(page, 'Tools'); await tools.focus(); await page.keyboard.down('Escape');
  await expect(scene(page)).toBeFocused(); expect(await page.evaluate(() => window.opacityHarness.state().tool)).toBe('brush');
  await page.keyboard.down('Escape'); await page.keyboard.up('Escape');
  expect(await page.evaluate(() => window.opacityHarness.state().tool)).toBe('brush'); retained(await snapshot(page), before);
  expect((await page.evaluate(() => window.opacityHarness.commands())).filter(name => name !== 'summary')).toEqual([]);
  await page.keyboard.press('Escape'); await expect.poll(() => page.evaluate(() => window.opacityHarness.state().tool)).toBeNull();
  retained(await snapshot(page), before);
  await button(page, 'Save scene').click(); const dialog = page.getByRole('dialog', { name: 'Save scene', exact: true });
  const field = dialog.getByRole('combobox', { name: 'Export format', exact: true }); await expect(field).toBeFocused();
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(button(page, 'Save scene')).toBeFocused();
  await page.keyboard.press('Escape'); await expect(scene(page)).toBeFocused(); retained(await snapshot(page), before);
});
