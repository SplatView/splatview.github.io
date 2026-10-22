import { expect, test, type Page } from '@playwright/test';
import { queuePly } from './queue-fixture';
import type { SavedViewRecord } from '../src/io/savedView';
import type {} from './opacity-harness';

const scene = (page: Page) => page.getByLabel('SplatView scene', { exact: true });
const background = (page: Page) => page.getByRole('button', { name: 'Background', exact: true });
const snapshot = (page: Page) => page.evaluate(() => window.opacityHarness.snapshot());
const camera = (page: Page) => page.evaluate(() => window.geometryViewer.controllerForSourceNavigation().camera!.state);
// Saved views are JSON: -0 serializes as 0. Compare that one representational
// difference explicitly while keeping every nonzero camera value exact.
const persistedCamera = (state: readonly number[]) => state.map(value => value === 0 ? 0 : value);
type Snapshot = Awaited<ReturnType<Window['opacityHarness']['snapshot']>>;
type KeyObservation = { trusted: boolean; prevented: boolean; repeat: boolean; canvas: boolean };
declare global { interface Window { thumbnailShortcutKeys: KeyObservation[] } }

async function appState(page: Page) {
  return page.evaluate(async () => {
    const url = '/src/app/store.ts';
    const { useApp } = await import(/* @vite-ignore */ url) as typeof import('../src/app/store');
    const state = useApp.getState();
    return { busy: state.busy, pending: state.thumbnailPending, transfer: state.viewTransferPending, status: state.viewStatus,
      hasSourceFingerprint: !!window.geometryViewer.controllerForSourceNavigation().sourceFingerprint,
      renderer: state.rendererState, recovery: state.selectionRecovery, dirty: state.dirty, error: state.error };
  });
}
async function settled(page: Page) {
  await expect.poll(() => appState(page)).toMatchObject({ busy: false, pending: false, transfer: false,
    renderer: 'ready', recovery: 'idle', hasSourceFingerprint: true, error: null });
}
async function boot(page: Page, mode: 'basic' | 'pro' = 'basic', literals = true) {
  await page.addInitScript(value => localStorage.setItem('splatview.tools-mode.v1', value), mode);
  await page.goto('/e2e/opacity-harness.html');
  await page.waitForFunction(() => window.geometryViewerError || window.opacityHarness?.ready());
  expect(await page.evaluate(() => window.geometryViewerError)).toBeUndefined();
  if (literals) {
    await page.evaluate(() => window.opacityHarness.load('thumbnail-shortcut-sh3.ply'));
    if (!(await page.evaluate(() => window.opacityHarness.state())).toolsOpen)
      await page.getByRole('button', { name: 'Tools', exact: true }).click();
    await settled(page);
  }
}
async function frames(page: Page) {
  await page.evaluate(async () => {
    for (let frame = 0; frame < 3; frame++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  });
}
async function observeKeys(page: Page) {
  await page.evaluate(() => {
    window.thumbnailShortcutKeys = [];
    window.addEventListener('keydown', event => {
      if (event.code !== 'KeyT') return;
      queueMicrotask(() => window.thumbnailShortcutKeys.push({ trusted: event.isTrusted, prevented: event.defaultPrevented,
        repeat: event.repeat, canvas: event.target === document.querySelector('canvas[aria-label="SplatView scene"]') }));
    });
  });
}
async function lastKey(page: Page) {
  return page.evaluate(() => window.thumbnailShortcutKeys.at(-1));
}

// Read the browser's actual atomic metadata/PNG pair. No storage, capture,
// thumbnail controller method or worker result is replaced by the spec.
async function savedPairs(page: Page) {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('splatview-views', 1);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      request.onupgradeneeded = () => { request.transaction?.abort(); reject(new Error('App has not initialized saved-view storage.')); };
    });
    let views: { recordId: string; meta: Blob }[] = [], images: { recordId: string; image: Blob }[] = [];
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(['views', 'thumbnails'], 'readonly');
        const records = transaction.objectStore('views').getAll(), thumbnails = transaction.objectStore('thumbnails').getAll();
        records.onsuccess = () => { views = records.result; }; thumbnails.onsuccess = () => { images = thumbnails.result; };
        transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error);
        transaction.onerror = () => reject(transaction.error);
      });
    } finally { database.close(); }
    if (views.length !== images.length) throw new Error('Saved-view metadata and thumbnail counts differ.');
    return Promise.all(views.sort((a, b) => a.recordId.localeCompare(b.recordId)).map(async stored => {
      const record = JSON.parse(await stored.meta.text()) as SavedViewRecord;
      const image = images.find(candidate => candidate.recordId === stored.recordId)?.image;
      if (!image) throw new Error('Saved thumbnail is missing.');
      const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await image.arrayBuffer())),
        byte => byte.toString(16).padStart(2, '0')).join('');
      const bitmap = await createImageBitmap(image);
      try {
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), context = canvas.getContext('2d')!;
        context.drawImage(bitmap, 0, 0); const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
        const corner = Array.from(pixels.subarray(0, 4)); let foreground = 0;
        for (let at = 0; at < pixels.length; at += 4)
          if (pixels[at] !== corner[0] || pixels[at + 1] !== corner[1] || pixels[at + 2] !== corner[2]) foreground++;
        return { record, image: { sha256, type: image.type, byteLength: image.size, width: bitmap.width, height: bitmap.height,
          corner, foreground } };
      } finally { bitmap.close(); }
    }));
  });
}
async function saveWithT(page: Page) {
  await scene(page).focus(); await expect(scene(page)).toBeFocused(); await page.keyboard.press('t');
  await expect.poll(() => appState(page)).toMatchObject({ pending: false, status: 'Thumbnail and default view saved in this browser.' });
  await settled(page);
  const pairs = await savedPairs(page); expect(pairs).toHaveLength(1); return pairs;
}
function retained(actual: Snapshot, before: Snapshot, sameRevision = true) {
  expect(actual.records).toEqual(before.records); expect(actual.gpuRecords).toEqual(before.gpuRecords);
  expect(actual.masks).toEqual(before.masks); expect(actual.gpuMasks).toEqual(before.gpuMasks);
  expect(actual.summary.contentRevision).toBe(before.summary.contentRevision);
  expect(actual.summary.canUndo).toBe(before.summary.canUndo); expect(actual.summary.canRedo).toBe(before.summary.canRedo);
  expect(actual.sourceFingerprint).toEqual(before.sourceFingerprint);
  if (sameRevision) { expect(actual.summary.revision).toBe(before.summary.revision); expect(actual.document).toEqual(before.document); }
}
async function redoBranch(page: Page) {
  for (const command of [{ command: 'single', index: 2, operation: 0 }, { command: 'delete' }] as const)
    expect(await page.evaluate(command => window.opacityHarness.command(command), command)).toBe(true);
  await settled(page); const edited = await snapshot(page);
  expect(edited.masks).toEqual([0, 0, 2, 0, 0, 0]); expect(edited.gpuMasks).toEqual(edited.masks);
  expect(await page.evaluate(() => window.opacityHarness.command({ command: 'undo' }))).toBe(true);
  await settled(page); const before = await snapshot(page);
  expect(before.masks).toEqual([0, 0, 1, 0, 0, 0]); expect(before.gpuMasks).toEqual(before.masks);
  expect(before.summary.canRedo).toBe(true); return { before, edited };
}
async function executeRedo(page: Page, edited: Snapshot) {
  await scene(page).focus(); await page.keyboard.press('ControlOrMeta+Shift+z'); await settled(page);
  await expect.poll(async () => (await snapshot(page)).masks).toEqual(edited.masks);
  const redone = await snapshot(page);
  expect(redone.records).toEqual(edited.records); expect(redone.gpuRecords).toEqual(edited.gpuRecords);
  expect(redone.gpuMasks).toEqual(edited.gpuMasks); expect(redone.summary.canRedo).toBe(false);
}

test.afterEach(async ({ page }) => { await page.evaluate(() => window.opacityHarness?.stop()); });

// Web-lite has no Pro profile.
for (const mode of ['basic'] as const) test(`${mode} focused T saves the actual PNG and camera default across Reset, rename and reload`, async ({ page }) => {
  await boot(page, mode, false);
  const input = { name: `thumbnail-${mode}.ply`, mimeType: 'application/octet-stream', buffer: Buffer.from(queuePly()) };
  await page.getByLabel('Open scene files').setInputFiles(input); await settled(page);
  const original = await camera(page); await scene(page).focus();
  await page.keyboard.down('ArrowRight');
  try { await expect.poll(() => camera(page)).not.toEqual(original); } finally { await page.keyboard.up('ArrowRight'); }
  await background(page).click(); await expect(background(page)).toHaveAttribute('data-background', 'gray');
  const savedCamera = persistedCamera(await camera(page)); await observeKeys(page); const pairs = await saveWithT(page);
  expect(await lastKey(page)).toEqual({ trusted: true, prevented: true, repeat: false, canvas: true });
  const [{ record, image }] = pairs;
  expect(record.view).toMatchObject({ target: savedCamera.slice(0, 3), yaw: savedCamera[3], pitch: savedCamera[4], distance: savedCamera[5],
    radius: savedCamera[6], fov: savedCamera[7], yUp: !!savedCamera[8], roll: savedCamera[9], background: 'gray' });
  expect(record.displayName).toBe(input.name); expect(image).toMatchObject(record.thumbnail);
  expect(image.width).toBeGreaterThan(0); expect(image.width).toBe(image.height); expect(image.foreground).toBeGreaterThan(0);
  image.corner.slice(0, 3).forEach(channel => expect(Math.abs(channel - 128)).toBeLessThanOrEqual(1)); expect(image.corner[3]).toBe(255);
  await background(page).click(); await expect(background(page)).toHaveAttribute('data-background', 'white');
  await page.getByRole('button', { name: 'Reset camera', exact: true }).click();
  await expect(background(page)).toHaveAttribute('data-background', 'gray'); expect(persistedCamera(await camera(page))).toEqual(savedCamera);
  await page.getByLabel('Open scene files').setInputFiles({ ...input, name: `renamed-thumbnail-${mode}.ply` });
  await expect(page).toHaveTitle(`renamed-thumbnail-${mode}.ply — SplatView`); await settled(page);
  await expect(background(page)).toHaveAttribute('data-background', 'gray'); expect(persistedCamera(await camera(page))).toEqual(savedCamera);
  expect(await savedPairs(page)).toEqual(pairs);
  await page.reload(); await page.waitForFunction(() => window.opacityHarness?.ready());
  await page.getByLabel('Open scene files').setInputFiles({ ...input, name: `reloaded-thumbnail-${mode}.ply` });
  await expect(page).toHaveTitle(`reloaded-thumbnail-${mode}.ply — SplatView`); await settled(page);
  await expect(background(page)).toHaveAttribute('data-background', 'gray'); expect(persistedCamera(await camera(page))).toEqual(savedCamera);
  expect(await savedPairs(page)).toEqual(pairs);
});

test('UI, Save, modified T and genuine autorepeat preserve stored default, native records and executable Redo', async ({ page }) => {
  await boot(page); const { before, edited } = await redoBranch(page); await observeKeys(page);
  const pairs = await saveWithT(page); retained(await snapshot(page), before);
  await background(page).click(); await expect(background(page)).toHaveAttribute('data-background', 'gray');
  await page.getByRole('button', { name: 'Tools', exact: true }).focus(); await page.keyboard.press('t');
  expect(await lastKey(page)).toMatchObject({ trusted: true, prevented: false, canvas: false });
  await page.getByRole('button', { name: 'Save scene', exact: true }).click();
  const save = page.getByRole('dialog', { name: 'Save scene', exact: true }); await expect(save).toBeVisible();
  await page.keyboard.press('t'); await expect(save).toBeVisible(); await page.keyboard.press('Escape'); await expect(save).toHaveCount(0);
  await scene(page).focus();
  for (const key of ['Shift+t', 'Alt+t']) {
    await page.keyboard.press(key); expect(await lastKey(page)).toMatchObject({ trusted: true, prevented: false, repeat: false, canvas: true });
  }
  await frames(page); expect(await savedPairs(page)).toEqual(pairs); retained(await snapshot(page), before);
  // Keep the physical key down through a completed real save, then refocus the
  // canvas after changing only the display. Playwright sends repeat=true for
  // the second down, so a consumed/reissued thumbnail would alter the record.
  await page.keyboard.down('t');
  try {
    await expect.poll(() => appState(page)).toMatchObject({ pending: false, status: 'Thumbnail and default view saved in this browser.' });
    await expect.poll(async () => (await savedPairs(page))[0].record.updatedAt).toBeGreaterThan(pairs[0].record.updatedAt);
    const heldPairs = await savedPairs(page); expect(heldPairs[0].record.view.background).toBe('gray');
    await background(page).click(); await expect(background(page)).toHaveAttribute('data-background', 'white'); await scene(page).focus();
    await page.keyboard.down('t'); await frames(page);
    expect(await lastKey(page)).toEqual({ trusted: true, prevented: false, repeat: true, canvas: true });
    expect(await savedPairs(page)).toEqual(heldPairs); retained(await snapshot(page), before);
  } finally { await page.keyboard.up('t'); }
  const fresh = await saveWithT(page); expect(fresh[0].record.view.background).toBe('white');
  retained(await snapshot(page), before); await executeRedo(page, edited);
});

test('real pointer capture rejects T without changing the default view, selection or native Redo branch', async ({ page }) => {
  await boot(page); const { before, edited } = await redoBranch(page); const pairs = await saveWithT(page); await observeKeys(page);
  const bounds = await scene(page).boundingBox(); expect(bounds).not.toBeNull();
  await scene(page).evaluate(element => element.addEventListener('pointerdown', event => {
    element.setAttribute('data-thumbnail-pointer', String((event as PointerEvent).pointerId));
  }, { once: true, capture: true }));
  await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2); await page.mouse.down({ button: 'middle' });
  try {
    await expect(scene(page)).toBeFocused();
    expect(await scene(page).evaluate(element => (element as HTMLCanvasElement).hasPointerCapture(Number(element.getAttribute('data-thumbnail-pointer'))))).toBe(true);
    await page.keyboard.press('t'); await frames(page);
    expect(await lastKey(page)).toEqual({ trusted: true, prevented: false, repeat: false, canvas: true });
    expect(await savedPairs(page)).toEqual(pairs); retained(await snapshot(page), before);
  } finally { await page.mouse.up({ button: 'middle' }); }
  await settled(page); retained(await snapshot(page), before); await executeRedo(page, edited);
});

// The held opacity-begin case needs Fade / boost, which is color.advanced and excluded from web-lite.
