import { expect, test, type Page } from '@playwright/test';
import { lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type {} from './sog-group-harness';
import type { OwnedSceneCollection } from '../src/io/sceneCollection';
import expected from '../tests/fixtures/sog-group-sh/expected-records.json' with { type: 'json' };
import keys from '../tests/fixtures/sog-group-sh/source-key-vectors.json' with { type: 'json' };
import nestedKey from '../tests/fixtures/scene-collection-nested-v1/expected-source-key.json' with { type: 'json' };

const packets = ['v1-sh1', 'v1-sh2', 'v1-sh3', 'v2-sh1', 'v2-sh2', 'v2-sh3'] as const;
const originals = ['meta.json', 'positions-high.webp', 'positions-low.webp', 'rotations.webp', 'appearance.webp',
  'declared-extra.bin', 'centroids.webp', 'labels.webp'];
const ordinary = readFileSync('tests/fixtures/formats/ply-splat-v1/sh3-ascii.ply');
let folder: string;
test.beforeAll(() => {
  folder = mkdtempSync(join(tmpdir(), 'splatview-owned-collection-'));
  writeFileSync(join(folder, '00-start.ply'), ordinary);
  packets.forEach((packet, index) => {
    const path = join(folder, `0${index + 1}-${packet}`); mkdirSync(path);
    for (const name of originals) writeFileSync(join(path, name), readFileSync(`tests/fixtures/sog-group-sh/packets/${packet}/collection/asset/${name}`));
  });
  writeFileSync(join(folder, 'unrelated-neighbor.bin'), Buffer.from('Unread collection neighbor.'));
});
test.afterAll(() => {
  if (!folder) return;
  const target = resolve(folder), temporaryRoot = resolve(tmpdir());
  if (dirname(target) !== temporaryRoot || !basename(target).startsWith('splatview-owned-collection-') || lstatSync(target).isSymbolicLink())
    throw new Error('The collection fixture cleanup target is outside its owned temporary directory.');
  rmSync(target, { recursive: true, force: true });
});
test.beforeEach(async ({ page }) => {
  await page.goto('/e2e/sog-group-harness.html');
  await page.waitForFunction(() => window.geometryViewerError || window.sogGroupHarness?.ready());
  expect(await page.evaluate(() => window.geometryViewerError)).toBeUndefined();
});

const snapshot = (page: Page) => page.evaluate(() => window.alignmentHarness.snapshot());
async function collection(page: Page) {
  return page.evaluate(() => {
    const app = window.geometryViewer.controllerForSourceNavigation();
    const owner = app as unknown as { collection?: OwnedSceneCollection; currentFile: number };
    return { paths: owner.collection?.entries.map(entry => entry.path) ?? [], index: owner.currentFile,
      previous: app.previousAssetPath ?? null, next: app.nextAssetPath ?? null,
      available: app.collectionNavigationAvailable, ...window.sogGroupHarness.ownership() };
  });
}
async function joined(page: Page) {
  await page.evaluate(() => window.sogGroupHarness.joinLoads());
  await expect.poll(() => page.evaluate(() => window.sogGroupHarness.ownership())).toMatchObject({ busy: false, pendingLoads: 0 });
}
async function at(page: Page, index: number, previousDocument?: string | null) {
  if (previousDocument !== undefined) await expect.poll(async () => (await collection(page)).activeDocumentId).not.toBe(previousDocument);
  await expect.poll(() => collection(page)).toMatchObject({ index, busy: false, candidateDocumentId: null }); await joined(page);
}
async function pageKey(page: Page, direction: 'PageUp' | 'PageDown', index: number) {
  const previous = (await collection(page)).activeDocumentId;
  await page.getByLabel('SplatView scene', { exact: true }).focus(); await page.keyboard.press(direction); await at(page, index, previous);
}
async function openFolder(page: Page) {
  await page.getByLabel('Open scene folder', { exact: true }).setInputFiles(folder); await at(page, 0);
}
const mirror = (value: Awaited<ReturnType<typeof snapshot>>) => {
  expect(value.records).toEqual(value.gpuRecords); expect(value.masks).toEqual(value.gpuMasks);
  expect(value.nativeRecordHash).toBe(value.gpuRecordHash);
};
function retained(after: Awaited<ReturnType<typeof snapshot>>, before: Awaited<ReturnType<typeof snapshot>>) {
  mirror(after);
  for (const key of ['records', 'gpuRecords', 'masks', 'gpuMasks', 'camera', 'defaultCamera', 'sourceFingerprint', 'exported'] as const)
    expect(after[key], key).toEqual(before[key]);
  expect(after.summary).toMatchObject({ revision: before.summary.revision, contentRevision: before.summary.contentRevision,
    canUndo: before.summary.canUndo, canRedo: before.summary.canRedo, selected: before.summary.selected });
}

type HeldDropObservation = { phase: 'scan' | 'getFile'; entered: boolean; released: boolean; completed: boolean;
  snapshots: number; getFileCalls: number; ledgerBytes: number; pendingLoads: number; cleanupCount: number;
  sameClient: boolean; sameScene: boolean; qualification: string };
declare global { interface Window { collectionDropObservation?: {
  release(): void; finished: Promise<void>; observation(): HeldDropObservation;
} } }
async function holdDrop(page: Page, phase: HeldDropObservation['phase']) {
  // Capture a real browser File separately so the incumbent remains the accepted document.
  await page.evaluate(() => {
    const input = document.createElement('input'); input.type = 'file'; input.hidden = true;
    input.setAttribute('aria-label', 'Collection callback fixture'); document.body.append(input);
  });
  await page.getByLabel('Collection callback fixture', { exact: true }).setInputFiles({ name: 'late.ply', mimeType: 'application/octet-stream', buffer: ordinary });
  await page.evaluate(phase => {
    const input = document.querySelector<HTMLInputElement>('[aria-label="Collection callback fixture"]')!, file = input.files![0]; input.remove();
    const app = window.geometryViewer.controllerForSourceNavigation(), beforeClient = app.client, beforeScene = app.scene;
    const owned = app as unknown as { ledger: { usage: { bytes: number } }; sourceLoads: Set<Promise<void>>; collectionCleanup: Set<Promise<void>> };
    let deliver: (() => void) | undefined, entered = false, released = false, completed = false, snapshots = 0, getFileCalls = 0;
    const selected = { name: file.name, isFile: true, isDirectory: false, file(yes: (file: File) => void) {
      getFileCalls++; if (phase === 'getFile') { entered = true; deliver = () => yes(file); } else yes(file);
    } };
    const directory = { name: 'selected-root', isFile: false, isDirectory: true, createReader() {
      let first = true;
      return { readEntries(yes: (entries: unknown[]) => void) {
        if (!first) { yes([]); return; } first = false;
        if (phase === 'scan') { entered = true; deliver = () => yes([selected]); } else yes([selected]);
      } };
    } };
    const drop = app.snapshotDrop({ items: [{ kind: 'file', webkitGetAsEntry() { snapshots++; return directory; } }] } as unknown as DataTransfer)!;
    const finished = app.openDrop(drop).then(() => { completed = true; });
    window.collectionDropObservation = { finished, release() { released = true; deliver!(); }, observation: () => ({
      phase, entered, released, completed, snapshots, getFileCalls, ledgerBytes: owned.ledger.usage.bytes,
      pendingLoads: owned.sourceLoads.size, cleanupCount: owned.collectionCleanup.size,
      sameClient: app.client === beforeClient, sameScene: app.scene === beforeScene,
      qualification: 'Entry callbacks deliver a real browser-input File; only callback delivery is held. Source bytes, native decoding and GPU results are unchanged.',
    }) };
  }, phase);
  await expect.poll(() => page.evaluate(() => window.collectionDropObservation!.observation().entered)).toBe(true);
}

test('real folder input navigates six nested v1/v2 SH1–3 graphs with whole original keys and native/GPU SH records', async ({ page }, info) => {
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const chooser = page.waitForEvent('filechooser'); await page.getByRole('button', { name: 'Open folder', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toHaveCount(0);
  expect((await chooser).isMultiple()).toBe(true); await (await chooser).setFiles(folder); await at(page, 0);
  const initial = await collection(page);
  expect(initial.paths).toEqual(['00-start.ply', ...packets.map((packet, index) => `0${index + 1}-${packet}/meta.json`)]);
  const observations = [];
  for (const [index, packet] of packets.entries()) {
    // Tools may remain open: Page keys belong to the scene, independently of edge hit areas.
    await pageKey(page, 'PageDown', index + 1); const actual = await snapshot(page); mirror(actual);
    const literal = expected.packets[packet], vector = keys.packets[packet].vectors.find(row => row.name === 'original-complete-group')!;
    expect(actual.summary).toMatchObject({ count: 3, shDegree: literal.shDegree, format: literal.format });
    expect(actual.sourceFingerprint).toMatchObject({ assetDigest: vector.assetDigest, resourceCount: vector.resourceCount, totalBytes: vector.totalBytes });
    actual.records.forEach((record, id) => {
      const appearance = new DataView(Uint8Array.from(record.appearance).buffer);
      expect(Array.from({ length: appearance.byteLength / 2 }, (_, component) => appearance.getUint16(component * 2, true)))
        .toEqual(literal.records[id].packedShHalfBits.slice(0, appearance.byteLength / 2));
    });
    observations.push({ catalog: await collection(page), snapshot: actual });
  }
  const last = await collection(page); await page.getByLabel('SplatView scene', { exact: true }).focus(); await page.keyboard.press('PageDown');
  await page.evaluate(() => new Promise<void>(yes => requestAnimationFrame(() => requestAnimationFrame(() => yes()))));
  expect((await collection(page)).activeDocumentId).toBe(last.activeDocumentId); expect((await collection(page)).index).toBe(6);
  await info.attach('collection-nested-sh-native-gpu.json', { body: JSON.stringify({ initial, observations, last }), contentType: 'application/json' });
});

test('real folder relative paths carry uppercase metadata, nested textures and shared-parent refs through the whole key and all SH3 GPU bands', async ({ page }, info) => {
  await page.evaluate(() => window.sogGroupHarness.observeReads());
  await page.getByLabel('Open scene folder', { exact: true }).setInputFiles('tests/fixtures/scene-collection-nested-v1/collection'); await at(page, 0);
  const catalog = await collection(page), actual = await snapshot(page); mirror(actual);
  expect(catalog.paths).toContain('asset/META.JSON'); expect(catalog.paths.every(path => !/\.(webp|bin)$/i.test(path))).toBe(true);
  const groupIndex = catalog.paths.indexOf('asset/META.JSON');
  for (let index = 1; index <= groupIndex; index++) await pageKey(page, 'PageDown', index);
  const grouped = groupIndex === 0 ? actual : await snapshot(page); mirror(grouped);
  expect(grouped.sourceFingerprint).toMatchObject({ scheme: nestedKey.scheme,
    resourceCount: nestedKey.resourceCount, totalBytes: nestedKey.totalBytes, assetDigest: nestedKey.assetDigest });
  expect(grouped.summary).toMatchObject({ count: 3, shDegree: 3, format: 'SOG v2' });
  grouped.records.forEach((record, id) => {
    const literal = expected.packets['v2-sh3'].records[id], appearance = new DataView(Uint8Array.from(record.appearance).buffer);
    record.position.forEach((value, axis) => expect(value).toBeCloseTo(literal.positionRub[axis], 5));
    record.covariance.forEach((value, component) => expect(value).toBeCloseTo(literal.covarianceRub[component], 4));
    expect(Array.from({ length: appearance.byteLength / 2 }, (_, component) => appearance.getUint16(component * 2, true)))
      .toEqual(literal.packedShHalfBits);
  });
  await joined(page); const reads = await page.evaluate(() => window.sogGroupHarness.finishReads());
  const group = reads.groups.find(group => group.descriptor.path === nestedKey.primaryPath)!;
  expect(group.completed).toBe(true); expect(group.error).toBeNull();
  expect(group.descriptor.resources.map(resource => ({ path: resource.path, bytes: resource.byteLength, role: resource.role })))
    .toEqual(nestedKey.resources.map(resource => ({ path: resource.path, bytes: resource.bytes, role: resource.role })));
  await info.attach('collection-real-nested-reference-key-native-gpu.json', { body: JSON.stringify({ catalog: await collection(page), key: nestedKey, snapshot: grouped, reads }), contentType: 'application/json' });
});

test('ordinary explicit files use natural nonwrapping order and edge chevrons obey Tools while Page keys remain available', async ({ page }) => {
  await page.getByLabel('Open scene files', { exact: true }).setInputFiles([
    { name: 'scene10.ply', mimeType: 'application/octet-stream', buffer: ordinary },
    { name: 'scene2.ply', mimeType: 'application/octet-stream', buffer: ordinary },
    { name: 'private.bin', mimeType: 'application/octet-stream', buffer: Buffer.from('unrelated') },
  ]); await at(page, 0);
  expect((await collection(page)).paths).toEqual(['scene2.ply', 'scene10.ply']);
  const tools = page.getByRole('complementary', { name: 'Tools', exact: true });
  if (!await tools.count()) await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Next asset', exact: true })).toHaveCount(0);
  await pageKey(page, 'PageDown', 1);
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Previous asset', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Next asset', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Previous asset', exact: true }).hover();
  await expect(page.getByRole('tooltip')).toContainText('scene2.ply');
  await page.getByRole('button', { name: 'Previous asset', exact: true }).click(); await at(page, 0);
});

test('read-only geometry in the same explicit collection keeps Page navigation available', async ({ page }) => {
  const geometry = Buffer.from('ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n-.4 0 0 255 0 0\n.4 0 0 0 255 0\n0 .4 .1 0 0 255\n');
  await page.getByLabel('Open scene files', { exact: true }).setInputFiles([
    { name: 'a-geometry.ply', mimeType: 'application/octet-stream', buffer: geometry },
    { name: 'b-gaussian.ply', mimeType: 'application/octet-stream', buffer: ordinary },
  ]); await at(page, 0);
  expect((await page.evaluate(() => window.geometryViewer.inspect())).summary).toMatchObject({ kind: 1, count: 3 });
  await expect(page.getByRole('complementary', { name: 'Tools', exact: true })).toHaveCount(0);
  await pageKey(page, 'PageDown', 1); mirror(await snapshot(page));
  await pageKey(page, 'PageUp', 0);
  expect((await page.evaluate(() => window.geometryViewer.inspect())).summary).toMatchObject({ kind: 1, count: 3 });
});

test('dirty adjacent Stay keeps the catalog and scene, and matching Save resumes the retained next entry', async ({ page }, info) => {
  await openFolder(page); const catalog = await collection(page);
  await page.evaluate(() => window.alignmentHarness.command({ command: 'transform', selectedOnly: false,
    matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, .125, 0, 0, 1] }));
  const before = await snapshot(page); expect(before.dirty).toBe(true);
  await page.getByLabel('SplatView scene', { exact: true }).focus(); await page.keyboard.press('PageDown');
  const dialog = page.getByRole('dialog', { name: 'Unsaved changes', exact: true }); await expect(dialog).toBeVisible();
  expect((await collection(page)).index).toBe(0); await dialog.getByRole('button', { name: 'Stay', exact: true }).click();
  retained(await snapshot(page), before); expect((await collection(page)).paths).toEqual(catalog.paths);
  await page.getByLabel('SplatView scene', { exact: true }).focus(); await page.keyboard.press('PageDown'); await expect(dialog).toBeVisible();
  const download = page.waitForEvent('download'); await dialog.getByRole('button', { name: 'Save', exact: true }).click(); await download;
  await page.getByRole('button', { name: 'I have kept the file', exact: true }).click(); await at(page, 1, catalog.activeDocumentId);
  expect((await collection(page)).paths).toEqual(catalog.paths);
  await info.attach('collection-dirty-save-resume.json', { body: JSON.stringify({ catalog, before, after: await collection(page) }), contentType: 'application/json' });
});

test('a refused adjacent source keeps actual edited Redo, source key, scene and accepted catalog index', async ({ page }, info) => {
  await page.getByLabel('Open scene files', { exact: true }).setInputFiles([
    { name: '00-kept.ply', mimeType: 'application/octet-stream', buffer: ordinary },
    { name: '01-refused.ply', mimeType: 'application/octet-stream', buffer: Buffer.from('invalid PLY') },
  ]); await at(page, 0);
  await page.evaluate(async () => {
    await window.alignmentHarness.command({ command: 'transform', selectedOnly: false, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, .125, 0, 0, 1] });
    await window.alignmentHarness.command({ command: 'undo' });
  });
  const before = await snapshot(page), owner = await collection(page); expect(before.summary.canRedo).toBe(true);
  await page.getByLabel('SplatView scene', { exact: true }).focus(); await page.keyboard.press('PageDown');
  const prompt = page.getByRole('dialog', { name: 'Unsaved changes', exact: true });
  if (before.dirty) { await expect(prompt).toBeVisible(); await prompt.getByRole('button', { name: 'Discard', exact: true }).click(); }
  await expect(page.getByRole('alert')).toBeVisible(); await joined(page);
  const after = await snapshot(page); retained(after, before);
  expect(await collection(page)).toMatchObject({ paths: owner.paths, index: 0, activeDocumentId: owner.activeDocumentId });
  await page.evaluate(() => window.alignmentHarness.command({ command: 'redo' }));
  const redone = await snapshot(page); mirror(redone);
  expect(redone.summary).toMatchObject({ canUndo: true, canRedo: false });
  expect(redone.nativeRecordHash).not.toBe(before.nativeRecordHash);
  expect(redone.sourceFingerprint).toEqual(before.sourceFingerprint);
  expect((await collection(page)).index).toBe(0);
  await info.attach('collection-refused-next-preserves-redo.json', { body: JSON.stringify({ owner, before, after, redone }), contentType: 'application/json' });
});

test('cancelled folder replacement retains the incumbent catalog through a held actual GPU allocation and joined retirement', async ({ page }, info) => {
  await page.getByLabel('Open scene files', { exact: true }).setInputFiles({ name: 'kept.ply', mimeType: 'application/octet-stream', buffer: ordinary });
  await at(page, 0); const before = await snapshot(page), owner = await collection(page);
  await page.evaluate(() => window.sogGroupHarness.holdAllocation());
  let held, cancelled, finished;
  try {
    await page.getByLabel('Open scene folder', { exact: true }).setInputFiles(folder);
    await expect.poll(() => page.evaluate(() => window.sogGroupHarness.allocationObservation().entered)).toBe(true);
    held = await page.evaluate(() => window.sogGroupHarness.allocationObservation());
    expect(await collection(page)).toMatchObject({ paths: owner.paths, index: owner.index, activeDocumentId: owner.activeDocumentId });
    await page.getByLabel('SplatView scene', { exact: true }).focus(); await page.keyboard.press('Escape');
    cancelled = await page.evaluate(() => window.sogGroupHarness.allocationObservation());
    expect(cancelled).toMatchObject({ busy: false, pendingLoads: 1, sameActiveClient: true, sameActiveScene: true });
    expect(cancelled.buffers.every(buffer => buffer.destroyCalls === 0)).toBe(true);
  } finally {
    await page.evaluate(() => { if (!window.sogGroupHarness.allocationObservation().released) window.sogGroupHarness.releaseAllocation(); });
    await joined(page); finished = await page.evaluate(() => window.sogGroupHarness.finishAllocation());
  }
  retained(await snapshot(page), before); expect(await collection(page)).toMatchObject({ paths: owner.paths, index: owner.index, activeDocumentId: owner.activeDocumentId });
  expect(finished.buffers.every(buffer => buffer.destroyCalls === 1)).toBe(true);
  await info.attach('collection-cancelled-folder-gpu-join.json', { body: JSON.stringify({ owner, before, held, cancelled, finished }), contentType: 'application/json' });
});

for (const phase of ['scan', 'getFile'] as const) test(`a superseded held ${phase} callback keeps its credit until delivery while the newer real scene wins`, async ({ page }, info) => {
  await page.getByLabel('Open scene files', { exact: true }).setInputFiles({ name: 'kept.ply', mimeType: 'application/octet-stream', buffer: ordinary });
  await at(page, 0); const owner = await collection(page), before = await snapshot(page);
  await holdDrop(page, phase); const held = await page.evaluate(() => window.collectionDropObservation!.observation());
  expect(held).toMatchObject({ entered: true, released: false, completed: false, snapshots: 1, sameClient: true, sameScene: true });
  expect(await collection(page)).toMatchObject({ paths: owner.paths, index: owner.index, activeDocumentId: owner.activeDocumentId });
  // Cancel observes the incumbent before a newer picker request supersedes the unfinished callbacks.
  await page.getByLabel('SplatView scene', { exact: true }).focus(); await page.keyboard.press('Escape');
  const cancelled = await page.evaluate(() => window.collectionDropObservation!.observation());
  expect(cancelled).toMatchObject({ completed: false, released: false, sameClient: true, sameScene: true, ledgerBytes: held.ledgerBytes });
  retained(await snapshot(page), before);
  let newer, finished;
  try {
    await page.getByLabel('Open scene files', { exact: true }).setInputFiles({ name: 'new-winner.ply', mimeType: 'application/octet-stream', buffer: ordinary });
    await expect.poll(() => collection(page)).toMatchObject({ paths: ['new-winner.ply'], index: 0, busy: false, candidateDocumentId: null });
    expect((await collection(page)).activeDocumentId).not.toBe(owner.activeDocumentId);
    newer = await snapshot(page); mirror(newer);
    expect(await page.evaluate(() => window.collectionDropObservation!.observation())).toMatchObject({ completed: false, released: false });
  } finally {
    await page.evaluate(async () => { const held = window.collectionDropObservation!; held.release(); await held.finished; });
    await joined(page); finished = await page.evaluate(() => window.collectionDropObservation!.observation());
  }
  expect(finished).toMatchObject({ completed: true, released: true, snapshots: 1, pendingLoads: 0, cleanupCount: 0, getFileCalls: phase === 'scan' ? 0 : 1 });
  expect((await collection(page)).paths).toEqual(['new-winner.ply']); retained(await snapshot(page), newer!);
  expect(await page.evaluate(() => window.sogGroupHarness.ownership().error)).toBeNull();
  await info.attach(`collection-superseded-${phase}-actual-delivery.json`, { body: JSON.stringify({ owner, before, held, cancelled, newer, finished }), contentType: 'application/json' });
});
