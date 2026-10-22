import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import type { SavedViewRecord } from '../src/io/savedView';
import { queuePly } from './queue-fixture';

const tools = (page: Page) => page.getByRole('complementary', { name: 'Tools', exact: true });
const settings = (page: Page) => page.getByRole('dialog', { name: 'Settings', exact: true });
const background = (page: Page) => page.getByRole('button', { name: 'Background', exact: true });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('splatview.ui-language.v1', 'en');
    localStorage.setItem('splatview.tutorial.v1', '{"tutorial_prompt_handled":"handled"}');
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Open scene', exact: true })).toBeEnabled();
});

test.afterEach(async ({ page, browser }, info) => {
  const environment = await page.evaluate(async () => {
    // This is an independent read-only adapter probe, not the renderer's owned
    // adapter or a measurement of available GPU memory.
    const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
    return { userAgent: navigator.userAgent, platform: navigator.platform, secureContext: isSecureContext,
      webGpu: !!navigator.gpu, origin: location.origin, devicePixelRatio, viewport: { width: innerWidth, height: innerHeight },
      adapterProbe: adapter ? { vendor: adapter.info.vendor, architecture: adapter.info.architecture,
        device: adapter.info.device, description: adapter.info.description, fallback: adapter.info.isFallbackAdapter } : null };
  });
  await info.attach('browser-environment.json', { body: JSON.stringify({ ...environment, browserVersion: browser.version() }), contentType: 'application/json' });
});

async function openExample(page: Page) {
  await page.getByRole('button', { name: 'Open example', exact: true }).click();
  await expect(page).toHaveTitle('Bench example.sog — SplatView');
  await expect(background(page)).toBeEnabled();
  await page.mouse.move(640, 400);
}

async function openSettings(page: Page) {
  if (!await page.getByRole('button', { name: 'Settings', exact: true }).isVisible())
    await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(settings(page)).toBeVisible();
  await settings(page).getByRole('tab', { name: 'General', exact: true }).click();
}

async function pair(page: Page) {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('splatview-views', 1);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try {
      const stored = await new Promise<{ metadata: { meta: Blob }[]; images: { recordId: string; image: Blob }[] }>((resolve, reject) => {
        const transaction = database.transaction(['views', 'thumbnails']);
        const records = transaction.objectStore('views').getAll(), images = transaction.objectStore('thumbnails').getAll();
        transaction.oncomplete = () => resolve({ metadata: records.result, images: images.result });
        transaction.onabort = () => reject(transaction.error);
      });
      return { records: await Promise.all(stored.metadata.map(async entry => JSON.parse(await entry.meta.text()) as SavedViewRecord)),
        images: await Promise.all(stored.images.map(async entry => ({ recordId: entry.recordId, type: entry.image.type, bytes: entry.image.size,
          sha256: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await entry.image.arrayBuffer())), value => value.toString(16).padStart(2, '0')).join('') }))) };
    } finally { database.close(); }
  });
}

async function remember(page: Page) {
  const button = settings(page).getByRole('button', { name: 'Remember view', exact: true });
  await expect(button).toBeEnabled(); await button.click();
  await expect(settings(page).getByRole('status').filter({ hasText: 'Thumbnail and default view saved in this browser.' }))
    .toHaveText('Thumbnail and default view saved in this browser.');
  await expect(button).toBeEnabled();
  return pair(page);
}

test('Scene files has one file-opening icon and keeps folder and remembered-view actions out of the toolbar', async ({ page }) => {
  const files = page.getByRole('group', { name: 'Scene files', exact: true });
  expect(await files.getByRole('button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label'))))
    .toEqual(['Open scene', 'Save scene', 'Capture image', 'Copy image']);
  await expect(page.getByRole('toolbar', { name: 'Scene controls', exact: true }).getByRole('button', { name: 'Open folder', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Update Thumbnail', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Remember view', exact: true })).toHaveCount(0);
  await openSettings(page);
  await expect(settings(page).getByRole('button', { name: 'Remember view', exact: true })).toBeDisabled();
  await expect(settings(page).getByRole('button', { name: 'Open folder', exact: true })).toBeEnabled();
  await settings(page).getByRole('button', { name: 'Close Settings', exact: true }).click();
  const pending = page.waitForEvent('filechooser'); await files.getByRole('button', { name: 'Open scene', exact: true }).click();
  const chooser = await pending;
  expect(chooser.isMultiple()).toBe(true);
  expect(await chooser.element().evaluate(input => (input as HTMLInputElement).hasAttribute('webkitdirectory'))).toBe(false);
  await chooser.setFiles({ name: 'simple-toolbar.ply', mimeType: 'application/octet-stream', buffer: Buffer.from(queuePly()) });
  await expect(page).toHaveTitle('simple-toolbar.ply — SplatView');
  await expect(files.getByRole('button', { name: 'Save scene', exact: true })).toBeEnabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('Remember view stores a real camera and PNG, restores camera and background, and preserves the existing Redo branch', async ({ page }, info) => {
  await openExample(page);
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await tools(page).getByRole('button', { name: 'Flip X', exact: true }).click();
  await tools(page).getByRole('button', { name: 'Apply transform', exact: true }).click();
  await expect(tools(page).getByRole('button', { name: 'Apply transform', exact: true })).toBeHidden();
  await tools(page).getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(tools(page).getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
  const title = await page.title(), statistics = await tools(page).locator('.model-stats').innerText();
  await page.getByRole('button', { name: 'Narrower lens', exact: true }).click();
  await page.getByRole('button', { name: 'Flip up', exact: true }).click();
  await background(page).click(); await expect(background(page)).toHaveAttribute('data-background', 'gray');
  await openSettings(page);
  const saved = await remember(page);
  expect(saved.records).toHaveLength(1); expect(saved.images).toHaveLength(1);
  expect(saved.records[0].view.background).toBe('gray');
  expect(saved.images[0]).toMatchObject({ recordId: saved.records[0].recordId, type: 'image/png', bytes: saved.records[0].thumbnail.byteLength,
    sha256: saved.records[0].thumbnail.sha256 });
  expect(saved.images[0].bytes).toBeGreaterThan(0);
  await settings(page).getByRole('button', { name: 'Close Settings', exact: true }).click();
  await expect(page).toHaveTitle(title);
  await expect(tools(page).locator('.model-stats')).toHaveText(statistics);
  await expect(tools(page).getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Wider lens', exact: true }).click();
  await page.getByRole('button', { name: 'Flip up', exact: true }).click();
  await background(page).click(); await expect(background(page)).toHaveAttribute('data-background', 'white');
  await page.getByRole('button', { name: 'Reset camera', exact: true }).click();
  await expect(background(page)).toHaveAttribute('data-background', 'gray');
  await openSettings(page);
  const reset = await remember(page);
  expect(reset.records).toHaveLength(1); expect(reset.images).toHaveLength(1);
  expect(reset.records[0].view).toEqual(saved.records[0].view);
  await settings(page).getByRole('button', { name: 'Close Settings', exact: true }).click();
  await expect(page).toHaveTitle(title);
  await expect(tools(page).locator('.model-stats')).toHaveText(statistics);
  await tools(page).getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(tools(page).getByRole('button', { name: 'Redo', exact: true })).toBeDisabled();
  await tools(page).getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(tools(page).getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await info.attach('remembered-view-and-redo.json', { body: JSON.stringify({ saved, reset, title, statistics }), contentType: 'application/json' });
});

test('Settings opens the existing directory picker and an empty folder preserves the current scene and history', async ({ page }, info) => {
  await openExample(page);
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await tools(page).getByRole('button', { name: 'Flip X', exact: true }).click();
  await tools(page).getByRole('button', { name: 'Apply transform', exact: true }).click();
  await expect(tools(page).getByRole('button', { name: 'Apply transform', exact: true })).toBeHidden();
  await tools(page).getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(tools(page).getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
  await background(page).click(); await expect(background(page)).toHaveAttribute('data-background', 'gray');
  const title = await page.title(), statistics = await tools(page).locator('.model-stats').innerText();
  await openSettings(page);
  const pending = page.waitForEvent('filechooser');
  await settings(page).getByRole('button', { name: 'Open folder', exact: true }).click();
  const chooser = await pending;
  await expect(settings(page)).toHaveCount(0);
  const picker = await chooser.element().evaluate(node => {
    const input = node as HTMLInputElement;
    return { label: input.getAttribute('aria-label'), directory: input.hasAttribute('directory'),
      webkitdirectory: input.hasAttribute('webkitdirectory'), multiple: input.multiple };
  });
  expect(picker).toEqual({ label: 'Open scene folder', directory: true, webkitdirectory: true, multiple: true });
  // An empty folder is a real directory choice with no scene files. This does
  // not qualify a particular operating system's native-dialog Cancel button.
  const emptyFolder = info.outputPath('empty-folder');
  await mkdir(emptyFolder, { recursive: true }); await chooser.setFiles(emptyFolder);
  expect(await chooser.element().evaluate(input => (input as HTMLInputElement).files?.length)).toBe(0);
  await expect(page).toHaveTitle(title);
  await expect(background(page)).toHaveAttribute('data-background', 'gray');
  await expect(tools(page).locator('.model-stats')).toHaveText(statistics);
  await expect(tools(page).getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
  await expect(page.getByRole('dialog', { name: 'Unsaved changes', exact: true })).toHaveCount(0);
  await tools(page).getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(tools(page).getByRole('button', { name: 'Redo', exact: true })).toBeDisabled();
  await tools(page).getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(tools(page).getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await info.attach('directory-picker-empty-folder.json', { body: JSON.stringify({ picker, title, statistics }), contentType: 'application/json' });
});
