import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import type {} from './native-memory-harness';
import { gaussianPly } from '../tests/fixtures/gaussians';

const MiB = 1024 * 1024, pageBytes = 65536, inputBytes = 40 * MiB;
const points = `ply
format ascii 1.0
element vertex 3
property float x
property float y
property float z
property uchar red
property uchar green
property uchar blue
end_header
-.4 0 0 255 0 0
.4 0 0 0 255 0
0 .4 .1 0 0 255
`;
function paddedFingerprint(source: 'gaussian' | 'points') {
  const bytes = source === 'gaussian' ? gaussianPly(0) : Buffer.from(points, 'utf8');
  const hash = createHash('sha256').update(bytes), spaces = Buffer.alloc(65536, 32);
  for (let left = inputBytes - bytes.byteLength; left > 0; left -= Math.min(left, spaces.length)) hash.update(spaces.subarray(0, Math.min(left, spaces.length)));
  // Independently assembled canonical v1 single-file byte table, including
  // the original padding that the decoder does not retain as scene records.
  const table = Buffer.alloc(69); table.write('SplatViewSource\0v1\0', 0, 'utf8');
  table.writeUInt32BE(1, 20); table[24] = 1; table.writeBigUInt64BE(BigInt(inputBytes), 29); hash.digest().copy(table, 37);
  return { scheme: 'splatview-source-v1', resourceCount: 1, totalBytes: inputBytes,
    assetDigest: createHash('sha256').update(table).digest('hex'), sourceKindHint: source === 'gaussian' ? 'PLY' : 'PLY point cloud' };
}
type Snapshot = Awaited<ReturnType<Window['nativeMemory']['retainedSource']>>['first'];
function retained(state: Snapshot) {
  expect(state.memory).toMatchObject({ observed: true, active: true, retired: false, ledgerOverageBytes: 0, unreconciledHeapBytes: null });
  expect(state.memory.heapBytes).toBeGreaterThan(32 * MiB);
  expect(state.memory.heapBytes % pageBytes).toBe(0);
  expect(state.summary.selectionMapBytes).toBe(0);
  expect(state.memory.coveredBytes).toBe(state.summary.memoryBytes);
  expect(state.memory.remainderBytes).toBe(state.memory.heapBytes - state.summary.memoryBytes);
  const remainder = state.accounting.nativeRemainder, catalog = state.accounting.catalog;
  if (!remainder || !catalog) throw new Error('The actual native remainder and catalog admission identities are required.');
  expect(remainder).toMatchObject({ live: true, owned: true, source: true, bytes: state.memory.remainderBytes });
  expect(catalog).toMatchObject({ live: true, owned: true, source: true }); expect(catalog.bytes).toBeGreaterThan(0);
  expect(remainder.id).not.toBe(catalog.id);
  for (const owner of [remainder, catalog]) expect(state.accounting.entries.filter(entry => entry.creditId === owner.id))
    .toEqual([{ category: 'source', bytes: owner.bytes, creditId: owner.id }]);
  expect(state.accounting.entries.filter(entry => entry.category === 'source').map(entry => entry.creditId).sort())
    .toEqual([remainder.id, catalog.id].sort());
  expect(state.accounting.bytes).toBe(state.accounting.entries.reduce((total, entry) => total + entry.bytes, 0));
  expect(state.census).toMatchObject({ ok: true, version: 1, scope: 'scoped-cxx-v1' });
  const census = state.census!;
  expect(census.scenePayloadBytes).toBeGreaterThan(0); expect(census.contextBytes).toBeGreaterThan(0);
  expect(census.liveBlocks).toBeGreaterThan(0); expect(census.liveContexts).toBeGreaterThan(0);
  expect(census.overlapBytes).toBe(census.scenePayloadBytes);
  expect(census.unionBytes).toBe(census.scenePayloadBytes + (census.ownedRawBytes - census.overlapBytes));
  expect(census.unionBytes).toBeLessThanOrEqual(state.memory.heapBytes);
  // The 40MiB input lease is separately owned and has been freed. Census scope
  // is actual surviving C++ storage, with no new host admission credit.
  expect(census.unionBytes).toBeLessThan(inputBytes);
}
function preserved(before: Snapshot, after: Snapshot) {
  for (const key of ['summary', 'capture', 'exported', 'gpuMasks', 'camera', 'cameraBackground', 'sourceFingerprint',
    'sourceName', 'sourceIndex', 'sourceFiles', 'dirty', 'background'] as const) expect(after[key]).toEqual(before[key]);
  expect(after.accounting).toEqual(before.accounting);
}
function realRedo(before: Snapshot, result: Pick<Awaited<ReturnType<Window['nativeMemory']['refusedCandidate']>>,
  'redone' | 'afterRedo' | 'undone' | 'afterUndo'>) {
  expect(before.summary.canRedo).toBe(true);
  expect(result.redone).toBe(true); expect(result.afterRedo.summary.canRedo).toBe(false);
  expect(result.afterRedo.exported).not.toBe(before.exported);
  expect(result.undone).toBe(true); expect(result.afterUndo.summary.canRedo).toBe(true);
  expect(result.afterUndo.exported).toBe(before.exported); expect(result.afterUndo.gpuMasks).toEqual(before.gpuMasks);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/e2e/native-memory-harness.html');
  await page.waitForFunction(() => window.geometryViewerError || window.nativeMemory?.ready());
  expect(await page.evaluate(() => window.geometryViewerError)).toBeUndefined();
});

for (const source of ['gaussian', 'points'] as const) {
  test(`actual ${source} staging free retains measured native heap instead of its initial allowance`, async ({ page }, testInfo) => {
    const result = await page.evaluate(source => window.nativeMemory.retainedSource(source), source);
    expect(result.inputBytes).toBe(inputBytes); expect(result.sameClient).toBe(true);
    for (const state of [result.first, result.settled]) {
      retained(state); expect(state.summary.count).toBe(3);
      expect(state.sourceFingerprint).toEqual(paddedFingerprint(source));
    }
    expect(result.settled.memory.heapBytes).toBe(result.first.memory.heapBytes);
    expect(result.settled.memory.sequence).toBeGreaterThan(result.first.memory.sequence);
    expect(result.settled.census!.sequence).toBeGreaterThan(result.first.census!.sequence);
    const { sequence: firstSequence, ...firstCounters } = result.first.census!;
    const { sequence: settledSequence, ...settledCounters } = result.settled.census!;
    expect(firstSequence).toBeGreaterThan(0); expect(settledSequence).toBeGreaterThan(firstSequence);
    expect(settledCounters).toEqual(firstCounters);
    expect(result.settled.accounting).toEqual(result.first.accounting);
    await testInfo.attach(`native-${source}-retention.json`, { body: JSON.stringify(result), contentType: 'application/json' });
  });
}

test('an actual grown inactive candidate refusal preserves edited source, key and executable Redo', async ({ page }, testInfo) => {
  const result = await page.evaluate(() => window.nativeMemory.refusedCandidate());
  expect(result.narrowed).toBe(true); expect(result.sameClient).toBe(true); expect(result.sameScene).toBe(true);
  expect(result.candidateMemory.retired).toBe(true);
  expect(result.candidateMemory.unreconciledHeapBytes).toBeGreaterThan(32 * MiB);
  expect(result.error).toMatch(/budget|memory|native/i); preserved(result.before, result.after); realRedo(result.before, result);
  await testInfo.attach('native-candidate-refusal.json', { body: JSON.stringify(result), contentType: 'application/json' });
});

test('a canceled actual Blob read retains its heap and exact read credit through successor publication', async ({ page }, testInfo) => {
  const result = await page.evaluate(() => window.nativeMemory.heldRead());
  const candidate = result.admitted.memory;
  expect(candidate.active).toBe(false); expect(candidate.retired).toBe(false);
  expect(candidate.heapBytes).toBeGreaterThan(32 * MiB); expect(candidate.coveredBytes).toBe(inputBytes);
  expect(candidate.remainderBytes).toBe(candidate.heapBytes - inputBytes);
  expect(result.admitted.nativeCredit).toMatchObject({ bytes: candidate.remainderBytes, live: true, owned: true, source: true });
  // Independent SH0 probe peak: 3*(CPU144 + packed48 + sort16 + rank4 +
  // projection48 + masks6) + one prefix block128 + base scratch4MiB.
  const decodedPeak = 3 * (144 + 48 + 16 + 4 + 48 + 6) + 128 + 4 * MiB;
  const stagedCatalog = result.admitted.catalog;
  expect(stagedCatalog).toMatchObject({ live: true, owned: true, source: true });
  if (stagedCatalog.bytes === null) throw new Error('The actual staged catalog credit is retired before its held read.');
  expect(stagedCatalog.bytes).toBeGreaterThan(0);
  expect(stagedCatalog.id).not.toBe(result.before.accounting.catalog!.id);
  expect(result.admitted.accounting.bytes - result.before.accounting.bytes)
    .toBe(candidate.heapBytes + pageBytes + 3 * MiB + decodedPeak + stagedCatalog.bytes);
  expect(result.cancelled).toMatchObject({ settled: false, disposed: true, sameClient: true, sameScene: true });
  expect(result.cancelled.memory.retired).toBe(false); expect(result.cancelled.accounting).toEqual(result.admitted.accounting);
  expect(result.cancelled.nativeCredit).toEqual(result.admitted.nativeCredit);
  expect(result.cancelled.catalog).toEqual(stagedCatalog);
  expect(result.beforeRelease.settled).toBe(false); expect(result.beforeRelease.memory.retired).toBe(false);
  expect(result.beforeRelease.nativeCredit).toEqual(result.admitted.nativeCredit);
  expect(result.beforeRelease.catalog).toEqual(stagedCatalog);
  expect(result.retiredCatalog).toEqual({ id: stagedCatalog.id, bytes: null, live: false, owned: false, source: false });
  expect(result.retiredNativeCredit).toEqual({ id: result.admitted.nativeCredit.id, bytes: null, live: false, owned: false, source: false });
  expect(result.candidateRetired).toBe(true); expect(result.sameSuccessor).toBe(true);
  expect(result.after.sourceName).toBe('successor.ply');
  expect(result.after.sourceFingerprint).toEqual(result.successorState.sourceFingerprint);
  expect(result.beforeRelease.accounting.bytes - result.after.accounting.bytes)
    .toBe(candidate.heapBytes + pageBytes + 3 * MiB + decodedPeak + stagedCatalog.bytes);
  await testInfo.attach('native-held-read.json', { body: JSON.stringify(result), contentType: 'application/json' });
});

test('actual held upload and GPU retirement retain the canceled candidate heap and admissions', async ({ page }, testInfo) => {
  const result = await page.evaluate(() => window.nativeMemory.heldUpload());
  expect(result.admitted.memory.heapBytes).toBeGreaterThan(32 * MiB);
  expect(result.admitted.nativeCredit).toMatchObject({ bytes: result.admitted.memory.remainderBytes, live: true, owned: true, source: true });
  expect(result.admitted.catalog).toMatchObject({ live: true, owned: true, source: true });
  expect(result.cancelled).toMatchObject({ settled: false, stagedRetired: false, sameClient: true, sameScene: true });
  expect(result.cancelled.memory.retired).toBe(false); expect(result.cancelled.accounting).toEqual(result.admitted.accounting);
  expect(result.cancelled.nativeCredit).toEqual(result.admitted.nativeCredit); expect(result.cancelled.catalog).toEqual(result.admitted.catalog);
  expect(result.retiring).toMatchObject({ settled: false, stagedRetired: true });
  expect(result.retiring.memory.retired).toBe(false); expect(result.retiring.accounting).toEqual(result.admitted.accounting);
  expect(result.retiring.nativeCredit).toEqual(result.admitted.nativeCredit); expect(result.retiring.catalog).toEqual(result.admitted.catalog);
  expect(result.retiredNativeCredit).toEqual({ id: result.admitted.nativeCredit.id, bytes: null, live: false, owned: false, source: false });
  expect(result.retiredCatalog).toEqual({ id: result.admitted.catalog.id, bytes: null, live: false, owned: false, source: false });
  expect(result.candidateRetired).toBe(true); preserved(result.before, result.after); realRedo(result.before, result);
  await testInfo.attach('native-held-upload-retirement.json', { body: JSON.stringify(result), contentType: 'application/json' });
});

test('controlled budget overage over a genuinely grown heap preserves the worker and closes through dirty protection', async ({ page }, testInfo) => {
  try {
    const result = await page.evaluate(() => window.nativeMemory.beginOverage());
    retained(result.before); expect(result.before.sourceFingerprint).toEqual(paddedFingerprint('gaussian'));
    expect(result.accounting.overageBytes).toBe(pageBytes); expect(result.memory.ledgerOverageBytes).toBe(pageBytes);
    expect(result.storeOverageBytes).toBe(pageBytes); expect(result.memory.active).toBe(true);
    expect(result.memory.retired).toBe(false); expect(result.sameWorker).toBe(true);
    expect(result.sameClient).toBe(true); expect(result.sameScene).toBe(true); expect(result.editingAvailable).toBe(false);
    expect(result.fingerprint).toEqual(result.before.sourceFingerprint);
    expect(result.names).toEqual(['a-kept.ply', 'z-next.ply']); expect(result.index).toBe(0);
    expect(result.summary).toEqual(result.before.summary); expect(result.after).toEqual(result.before.summary);
    expect(result.cleanup).toEqual(result.before.summary); expect(result.edited).toBe(false);
    expect(result.directError).toMatch(/budget|memory/i); expect(result.captureError).toMatch(/budget|memory/i);
    expect(result.posted).toEqual(['cancelSelection', 'summary']);
    const close = page.getByRole('alert').getByRole('button', { name: 'Close scene', exact: true });
    await expect(close).toBeEnabled();
    await close.click();
    const dialog = page.getByRole('dialog', { name: 'Unsaved changes' }); await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    await dialog.getByRole('button', { name: 'Stay', exact: true }).click();
    const stayed = await page.evaluate(() => window.nativeMemory.overageState());
    expect(stayed.scene).toBe(true); expect(stayed.client).toBe(true); expect(stayed.overageBytes).toBe(pageBytes);
    expect(stayed.fingerprint).toEqual(result.before.sourceFingerprint);
    await close.click();
    await dialog.getByRole('button', { name: 'Discard and close', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.nativeMemory.overageState())).toEqual({ scene: false, client: false,
      fingerprint: null, names: [], index: 0, overageBytes: 0,
      accounting: { bytes: 0, allocations: 0, entries: [], overageBytes: 0 }, navigationPrompt: false });
    await testInfo.attach('native-active-overage.json', { body: JSON.stringify({ ...result, stayed }), contentType: 'application/json' });
  } finally { await page.evaluate(() => window.nativeMemory.resetBudget()); }
});
