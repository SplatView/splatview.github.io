import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type {} from './sog-group-harness';
import expectedV1 from '../tests/fixtures/sog-group-v1/expected-records.json' with { type: 'json' };
import vectorsV1 from '../tests/fixtures/sog-group-v1/source-key-vectors.json' with { type: 'json' };
import expectedV2 from '../tests/fixtures/sog-group-v2/expected-records.json' with { type: 'json' };
import vectorsV2 from '../tests/fixtures/sog-group-v2/source-key-vectors.json' with { type: 'json' };
import expectedSH from '../tests/fixtures/sog-group-sh/expected-records.json' with { type: 'json' };
import vectorsSH from '../tests/fixtures/sog-group-sh/source-key-vectors.json' with { type: 'json' };

type Snapshot = Awaited<ReturnType<Window['alignmentHarness']['snapshot']>>;
type Payload = { name: string; mimeType: string; buffer: Buffer };
test.beforeEach(async ({ page }) => {
  await page.goto('/e2e/sog-group-harness.html');
  await page.waitForFunction(() => window.geometryViewerError || window.sogGroupHarness?.ready());
  expect(await page.evaluate(() => window.geometryViewerError)).toBeUndefined();
  await expect(page.getByRole('button', { name: 'Open scene', exact: true })).toBeEnabled();
});

const higherPackets = ['v1-sh1', 'v1-sh2', 'v1-sh3', 'v2-sh1', 'v2-sh2', 'v2-sh3'] as const;
const datasets = [
  { version: 1, degree: 0, expected: expectedV1, vectors: vectorsV1, fixtureRoot: 'tests/fixtures/sog-group-v1/', prefix: '' },
  { version: 2, degree: 0, expected: expectedV2, vectors: vectorsV2, fixtureRoot: 'tests/fixtures/sog-group-v2/', prefix: 'v2 ' },
  ...higherPackets.map(packet => ({ version: packet.startsWith('v1-') ? 1 : 2, degree: expectedSH.packets[packet].shDegree,
    expected: expectedSH.packets[packet], vectors: vectorsSH.packets[packet],
    fixtureRoot: `tests/fixtures/sog-group-sh/packets/${packet}/`, prefix: packet.replace('-sh', ' SH') + ' ' })),
];
for (const { version, degree, expected, vectors, fixtureRoot, prefix } of datasets) {
  // Preserve all fourteen qualified SH0 titles; each new dataset adds seven
  // real App workflows with its version/band prefix and actual resource count.
  const caseTitle = (title: string) => prefix + (degree ? title.replace('six original', 'eight original') : title);
  const originals = ['meta.json', 'positions-high.webp', 'positions-low.webp', 'rotations.webp', 'appearance.webp', 'declared-extra.bin',
    ...(degree ? ['centroids.webp', 'labels.webp'] : [])];
  const originalKey = vectors.vectors.find(vector => vector.name === 'original-complete-group')!;
  const extraKey = vectors.vectors.find(vector => vector.name === 'declared-extra-last-byte-changed')!;
  const neighborKey = vectors.vectors.find(vector => vector.name === 'unrelated-neighbor-bytes-changed' || vector.name === 'unrelated-neighbor-mutated')!;
  const tools = (page: Page) => page.getByRole('complementary', { name: 'Tools', exact: true });
  const snapshot = (page: Page) => page.evaluate(() => window.alignmentHarness.snapshot());
  function inputs(): Payload[] {
    return [...originals.map(name => ({ name, mimeType: name.endsWith('.webp') ? 'image/webp' : 'application/octet-stream',
      buffer: readFileSync(fixtureRoot + 'collection/asset/' + name) })),
    { name: 'unrelated-neighbor.bin', mimeType: 'application/octet-stream', buffer: readFileSync(fixtureRoot + 'collection/unrelated-neighbor.bin') }];
  }
  const changedExtra = () => inputs().map(item => item.name === 'declared-extra.bin' ? { ...item, buffer: Buffer.from(item.buffer.map((value, index) => index === item.buffer.length - 1 ? 33 : value)) } : item);
  async function fingerprint(page: Page, assetDigest = originalKey.assetDigest, previousDocumentId?: string | null) {
    if (previousDocumentId !== undefined)
      await expect.poll(() => page.evaluate(() => window.sogGroupHarness.ownership().activeDocumentId)).not.toBe(previousDocumentId);
    await expect.poll(() => page.evaluate(() => window.sogGroupHarness.ownership())).toMatchObject({ busy: false,
      sourceName: 'meta.json', fingerprint: { scheme: 'splatview-source-v1', sourceKindHint: `SOG v${version}`, resourceCount: originalKey.resourceCount, totalBytes: originalKey.totalBytes, assetDigest } });
  }
  async function joined(page: Page) {
    await page.evaluate(() => window.sogGroupHarness.joinLoads());
    await expect.poll(() => page.evaluate(() => window.sogGroupHarness.ownership())).toMatchObject({ busy: false, pendingLoads: 0, candidateDocumentId: null });
  }
  async function changed(page: Page, previousRevision: number) {
    await expect.poll(() => page.evaluate(previous => {
      const current = window.sogGroupHarness.ownership();
      return current.busy ? previous : current.summary?.revision ?? previous;
    }, previousRevision)).toBeGreaterThan(previousRevision);
  }
  async function open(page: Page, values = inputs()) {
    await page.getByLabel('Open scene files', { exact: true }).setInputFiles(values); await fingerprint(page); await joined(page);
  }
  async function drop(page: Page, values: Payload[]) {
    await page.evaluate(values => {
      const transfer = new DataTransfer();
      for (const value of values) transfer.items.add(new File([new Uint8Array(value.bytes)], value.name, { type: value.mimeType }));
      document.querySelector('main')!.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    }, values.map(({ name, mimeType, buffer }) => ({ name, mimeType, bytes: [...buffer] })));
  }
  async function showTools(page: Page) {
    if (!await tools(page).count()) await page.getByRole('button', { name: 'Tools', exact: true }).click();
    await expect(tools(page)).toBeVisible();
  }
  function mirrors(value: Snapshot) {
    expect(value.records).toEqual(value.gpuRecords); expect(value.masks).toEqual(value.gpuMasks);
    expect(value.nativeRecordHash).toBe(value.gpuRecordHash);
  }
  function halfNumber(bits: number) {
    const sign = bits & 0x8000 ? -1 : 1, exponent = bits >>> 10 & 31, fraction = bits & 1023;
    return sign * (exponent === 0 ? fraction * 2 ** -24 : (1 + fraction / 1024) * 2 ** (exponent - 15));
  }
  function independentRecords(value: Snapshot) {
    mirrors(value); expect(value.summary).toMatchObject({ loaded: true, count: 3, sourceCount: 3, shDegree: degree, format: `SOG v${version}`, yUp: true });
    expect(value.records).toHaveLength(3); expect(value.masks).toEqual([0, 0, 0]);
    for (const [index, record] of value.records.entries()) {
      const literal = expected.records[index];
      record.position.forEach((number, axis) => expect(Math.abs(number - literal.positionRub[axis])).toBeLessThanOrEqual(expected.numericPolicy.positionsAbsolute));
      const variance = Math.max(...literal.linearScales.map(scale => scale * scale));
      record.covariance.forEach((number, axis) => expect(Math.abs(number - literal.covarianceRub[axis])).toBeLessThanOrEqual(variance * expected.numericPolicy.covarianceRelativeToMaxAxisVariance));
      const opacity = new DataView(Uint8Array.from(record.opacity).buffer).getFloat32(0, true);
      expect(Math.abs(opacity - literal.opacity)).toBeLessThanOrEqual(expected.numericPolicy.opacityAbsolute);
      const appearance = new DataView(Uint8Array.from(record.appearance).buffer);
      expect([0, 2, 4].map(offset => halfNumber(appearance.getUint16(offset, true)))).toEqual(literal.packedDcHalf);
      if ('packedShHalfBits' in literal) {
        // Every active band and copied whole-word tail is compared against the
        // independent literal, after mirrors() checks the actual GPU readback.
        expect(Array.from({ length: appearance.byteLength / 2 }, (_, component) => appearance.getUint16(component * 2, true)))
          .toEqual(literal.packedShHalfBits.slice(0, appearance.byteLength / 2));
      }
    }
  }
  function retained(value: Snapshot, before: Snapshot, pendingWork = false) {
    mirrors(value);
    for (const key of ['records', 'gpuRecords', 'masks', 'gpuMasks', 'nativeRecordHash', 'gpuRecordHash', 'camera', 'defaultCamera', 'background', 'sourceFingerprint', 'exported'] as const)
      expect(value[key], key).toEqual(before[key]);
    if (!pendingWork) expect(value.work).toEqual(before.work);
    expect(value.summary).toMatchObject({ revision: before.summary.revision, contentRevision: before.summary.contentRevision,
      canUndo: before.summary.canUndo, canRedo: before.summary.canRedo, selected: before.summary.selected });
  }
  const translation = (x: number) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1];
  async function editedBaseline(page: Page) {
    await page.evaluate(async matrix => {
      await window.alignmentHarness.load('sog-kept-edited.ply'); await window.alignmentHarness.seed([1]);
      await window.alignmentHarness.command({ command: 'transform', matrix: matrix[0], selectedOnly: false });
      await window.alignmentHarness.command({ command: 'transform', matrix: matrix[1], selectedOnly: false });
      await window.alignmentHarness.command({ command: 'undo' }); window.alignmentHarness.navigate();
    }, [translation(.125), translation(.25)]);
    const before = await snapshot(page); mirrors(before); expect(before.summary.canRedo).toBe(true); expect(before.dirty).toBe(true); return before;
  }


  test(caseTitle('Basic actual file input loads six original SOG resources once and matches independent records and complete source-key literals'), async ({ page }, testInfo) => {
    await page.evaluate(() => window.sogGroupHarness.observeReads());
    const chooser = page.waitForEvent('filechooser'); await page.getByRole('button', { name: 'Open scene', exact: true }).click();
    await (await chooser).setFiles(inputs().reverse()); await fingerprint(page); await joined(page); await showTools(page);
    // web-lite has no Basic/Pro toggle (processing.advanced).
    await expect(tools(page).locator('.mode-button')).toBeHidden();
    await expect(tools(page).getByRole('button', { name: 'Alignment', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Save scene', exact: true })).toBeEnabled();
    const value = await snapshot(page); independentRecords(value);
    expect(value.sourceFingerprint).toEqual({ scheme: originalKey.scheme, assetDigest: originalKey.assetDigest,
      resourceCount: originalKey.resourceCount, totalBytes: originalKey.totalBytes, sourceKindHint: `SOG v${version}` });
    const reads = await page.evaluate(() => window.sogGroupHarness.finishReads());
    expect(reads.catalog).toEqual(['meta.json']); expect(reads.catalogFrozen).toBe(true); expect(reads.currentFile).toBe(0);
    expect(reads.groups).toHaveLength(1); expect(reads.groups[0].descriptor.resources.map(item => item.path)).toEqual([
      'meta.json', ...originals.filter(name => name !== 'meta.json').sort()]);
    expect(reads.groups[0].descriptor.resources.map(item => item.role)).toEqual(['primary', ...Array(originals.length - 1).fill('referenced')]);
    for (const name of originals.filter(name => name !== 'meta.json'))
      expect(reads.reads.filter(entry => entry.name === name)).toHaveLength(1);
    expect(reads.reads.some(entry => entry.name === 'unrelated-neighbor.bin')).toBe(false);
    expect(reads.groups[0].descriptor.byteLength).toBe(originalKey.totalBytes); expect(reads.groups[0].completed).toBe(true);
    await testInfo.attach('sog-basic-independent-native-gpu-group.json', { body: JSON.stringify({ numericPolicy: expected.numericPolicy, value, reads }), contentType: 'application/json' });
  });

  test(caseTitle('actual drop retains ordinary transform/history controls and real PLY export/reopen semantics'), async ({ page }, testInfo) => {
    await drop(page, inputs()); await fingerprint(page); await joined(page); await showTools(page);
    const before = await snapshot(page); independentRecords(before);
    // Numeric transform fields are excluded from web-lite (transform.numeric); apply the same
    // translation through the controller's transform session, which the gizmo also uses.
    expect(await page.evaluate(async () => {
      const app = window.geometryViewer.controllerForSourceNavigation();
      app.setTransformParameters({ translation: [.125, 0, 0] });
      for (const start = performance.now(); (!app.transformDirty || app.transformPending) && performance.now() - start < 10_000;)
        await new Promise(resolve => setTimeout(resolve, 5));
      return app.applyTransform();
    })).toBe(true);
    await changed(page, before.summary.revision);
    // Numeric Apply retains the entry GPU geometry with an absolute preview.
    // Materialize accepted content before this observational/export snapshot.
    const settlement = await page.evaluate(async () => {
      const app = window.geometryViewer.controllerForSourceNavigation(), before = window.sogGroupHarness.ownership();
      const activeBefore = app.transformActive, ended = await app.endTransformSession();
      return { before, after: window.sogGroupHarness.ownership(), activeBefore, activeAfter: app.transformActive, ended };
    });
    expect(settlement.activeBefore).toBe(true); expect(settlement.ended).toBe(true); expect(settlement.activeAfter).toBe(false);
    expect(settlement.after.summary).toEqual(settlement.before.summary);
    for (const key of ['activeDocumentId', 'sourceName', 'fingerprint', 'catalog', 'currentFile'] as const)
      expect(settlement.after[key], key).toEqual(settlement.before[key]);
    const moved = await snapshot(page); mirrors(moved); expect(moved.records).not.toEqual(before.records);
    expect(moved.records.map(record => record.position[0])).toEqual(before.records.map(record => Math.fround(record.position[0] + .125)));
    expect(moved.sourceFingerprint).toEqual(before.sourceFingerprint);
    await tools(page).getByRole('button', { name: 'Undo', exact: true }).click();
    await changed(page, moved.summary.revision);
    const undone = await snapshot(page); mirrors(undone); expect(undone.records).toEqual(before.records);
    await tools(page).getByRole('button', { name: 'Redo', exact: true }).click();
    await changed(page, undone.summary.revision);
    const redone = await snapshot(page); mirrors(redone); expect(redone.records).toEqual(moved.records);
    await page.getByRole('button', { name: 'Save scene', exact: true }).click();
    await page.getByLabel('Export format', { exact: true }).selectOption('0'); await page.getByLabel('Export scope', { exact: true }).selectOption('0');
    const download = page.waitForEvent('download'); await page.getByRole('dialog', { name: 'Save scene', exact: true }).getByRole('button', { name: 'Download', exact: true }).click();
    const actual = await download, stream = await actual.createReadStream(); if (!stream) throw new Error('Actual PLY download is unavailable.');
    const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks); expect(actual.suggestedFilename()).toMatch(/\.ply$/);
    await page.getByRole('button', { name: 'I have kept the file', exact: true }).click();
    await page.getByLabel('Open scene files', { exact: true }).setInputFiles({ name: 'sog-exported-reopen.ply', mimeType: 'application/octet-stream', buffer: bytes });
    await expect.poll(() => page.evaluate(() => window.sogGroupHarness.ownership())).toMatchObject({ busy: false, sourceName: 'sog-exported-reopen.ply' }); await joined(page);
    const reopened = await snapshot(page); mirrors(reopened); expect(reopened.summary).toMatchObject({ count: 3, shDegree: degree, format: 'PLY', canUndo: false, canRedo: false });
    reopened.records.forEach((record, index) => {
      record.position.forEach((value, axis) => expect(Math.abs(value - moved.records[index].position[axis])).toBeLessThanOrEqual(expected.numericPolicy.positionsAbsolute));
      const variance = Math.max(...expected.records[index].linearScales.map(scale => scale * scale));
      record.covariance.forEach((value, axis) => expect(Math.abs(value - moved.records[index].covariance[axis])).toBeLessThanOrEqual(variance * expected.numericPolicy.covarianceRelativeToMaxAxisVariance));
      expect(record.appearance).toEqual(moved.records[index].appearance);
    });
    expect(reopened.sourceFingerprint!.resourceCount).toBe(1); expect(reopened.sourceFingerprint!.assetDigest).not.toBe(originalKey.assetDigest);
    await testInfo.attach('sog-real-transform-history-ply-reopen.json', { body: JSON.stringify({ before, moved, undone, redone, reopened, downloadName: actual.suggestedFilename() }), contentType: 'application/json' });
  });

  test(caseTitle('declared unused bytes change the independent group key while an unread unrelated neighbor does not change decoded records'), async ({ page }, testInfo) => {
    await open(page); const before = await snapshot(page); independentRecords(before);
    const previousDocumentId = await page.evaluate(() => window.sogGroupHarness.ownership().activeDocumentId);
    await page.evaluate(() => window.sogGroupHarness.observeReads());
    const changedNeighbor = inputs().map(item => item.name === 'unrelated-neighbor.bin' ? { ...item, buffer: Buffer.from('changed unrelated neighbor\n') } : item);
    await page.getByLabel('Open scene files', { exact: true }).setInputFiles(changedNeighbor); await fingerprint(page, neighborKey.assetDigest, previousDocumentId); await joined(page);
    const neighbor = await snapshot(page); independentRecords(neighbor); expect(neighbor.records).toEqual(before.records);
    await page.getByLabel('Open scene files', { exact: true }).setInputFiles(changedExtra()); await fingerprint(page, extraKey.assetDigest); await joined(page);
    const extra = await snapshot(page); independentRecords(extra); expect(extra.records).toEqual(before.records); expect(extra.masks).toEqual(before.masks);
    const reads = await page.evaluate(() => window.sogGroupHarness.finishReads());
    expect(reads.reads.some(entry => entry.name === 'unrelated-neighbor.bin')).toBe(false);
    expect(reads.groups).toHaveLength(2); reads.groups.forEach(group => expect(group.descriptor.resources).toHaveLength(originals.length));
    await testInfo.attach('sog-unused-extra-and-unread-neighbor-literals.json', { body: JSON.stringify({ before, neighbor, extra, reads }), contentType: 'application/json' });
  });

  test(caseTitle('missing/malformed/unsupported groups and a real truncated WebP retain the edited source, native/GPU bytes and executable Redo'), async ({ page }, testInfo) => {
    const before = await editedBaseline(page), catalog = await page.evaluate(() => window.sogGroupHarness.ownership());
    const attempts: { name: string; after: Snapshot }[] = [];
    for (const name of ['missing appearance', 'malformed metadata', 'version3', 'invalid SH layout', 'truncated WebP']) {
      let values = inputs();
      if (name === 'missing appearance') values = values.filter(item => item.name !== 'appearance.webp');
      else if (name === 'truncated WebP') values = values.map(item => item.name === 'positions-low.webp' ? { ...item, buffer: item.buffer.subarray(0, 12) } : item);
      else values = values.map(item => {
        if (item.name !== 'meta.json') return item;
        if (name === 'malformed metadata') return { ...item, buffer: Buffer.from('{"means":') };
        const metadata = JSON.parse(item.buffer.toString('utf8'));
        if (name === 'version3') { metadata.version = 3; metadata.count = 3; metadata.scales.codebook = [0]; metadata.sh0.codebook = [0]; }
        else metadata.shN = version === 1 ? { files: ['appearance.webp', 'rotations.webp'], mins: -1, maxs: 1 } :
          { files: ['appearance.webp', 'rotations.webp'], bands: 4, count: 64, codebook: [0] };
        return { ...item, buffer: Buffer.from(JSON.stringify(metadata)) };
      });
      await page.getByLabel('Open scene files', { exact: true }).setInputFiles(values);
      await page.getByRole('dialog', { name: 'Unsaved changes', exact: true }).getByRole('button', { name: 'Discard', exact: true }).click();
      await expect(page.getByRole('alert')).toBeVisible(); await joined(page);
      const after = await snapshot(page); retained(after, before); expect(after.dirty).toBe(true);
      const current = await page.evaluate(() => window.sogGroupHarness.ownership());
      expect(current.catalog).toEqual(catalog.catalog); expect(current.currentFile).toBe(catalog.currentFile); expect(current.activeDocumentId).toBe(catalog.activeDocumentId);
      attempts.push({ name, after }); await page.getByRole('button', { name: 'Dismiss error', exact: true }).click();
    }
    await page.evaluate(() => window.alignmentHarness.command({ command: 'redo' })); const redone = await snapshot(page); mirrors(redone); expect(redone.records).not.toEqual(before.records);
    await page.evaluate(() => window.alignmentHarness.command({ command: 'undo' })); const undone = await snapshot(page); mirrors(undone);
    expect(undone.records).toEqual(before.records); expect(undone.masks).toEqual(before.masks);
    expect(undone.sourceFingerprint).toEqual(before.sourceFingerprint); expect(undone.summary.canRedo).toBe(true);
    await testInfo.attach('sog-real-refusals-retained-redo.json', { body: JSON.stringify({ before, catalog, attempts, redone, undone }), contentType: 'application/json' });
  });

  test(caseTitle('UI Cancel joins held middle referenced-resource delivery before metadata/producer/receive/stage credits retire'), async ({ page }, testInfo) => {
    await page.evaluate(() => window.alignmentHarness.load('sog-kept-cancel.ply')); const before = await snapshot(page); mirrors(before);
    const baseline = await page.evaluate(() => window.sogGroupHarness.ownership());
    const heldBytes = inputs().find(item => item.name === 'positions-high.webp')!.buffer.length;
    let held!: ReturnType<Window['sogGroupHarness']['readObservation']>;
    let cancelled!: typeof held, finished!: typeof held;
    await page.evaluate(() => window.sogGroupHarness.observeReads('positions-high.webp'));
    try {
      await page.getByLabel('Open scene files', { exact: true }).setInputFiles(inputs());
      await expect.poll(() => page.evaluate(() => window.sogGroupHarness.readObservation().held)).toBe(true);
      held = await page.evaluate(() => window.sogGroupHarness.readObservation());
      expect(held.sameActiveClient).toBe(true); expect(held.sameActiveScene).toBe(true); expect(held.groups[0].metadataCredits).toHaveLength(2);
      const transfer = held.heldCandidate!.transfers[0], broker = transfer.brokers.find(value => value.pending)!;
      expect(transfer.stageBytes).toBeGreaterThan(0); expect(transfer.receiveBytes).toBe(heldBytes); expect(broker.producerBytes).toBe(2 * heldBytes);
      expect(broker.byteLength).toBe(heldBytes); expect(broker.consumedBytes).toBe(0);
      await page.locator('.status').getByRole('button', { name: 'Cancel', exact: true }).click();
      cancelled = await page.evaluate(() => window.sogGroupHarness.readObservation());
      expect(cancelled.busy).toBe(false); expect(cancelled.pendingLoads).toBe(1); expect(cancelled.sameActiveClient).toBe(true);
      expect(cancelled.heldCandidate!.transfers[0].stageBytes).toBe(transfer.stageBytes);
      expect(cancelled.heldCandidate!.transfers[0].receiveBytes).toBe(heldBytes);
      expect(cancelled.heldCandidate!.transfers[0].brokers.find(value => value.pending)!.producerBytes).toBe(2 * heldBytes);
      expect(cancelled.groups[0].metadataCredits).toEqual(held.groups[0].metadataCredits);
      const during = await snapshot(page); retained(during, before, true);
    } finally {
      await page.evaluate(() => { if (!window.sogGroupHarness.readObservation().released) window.sogGroupHarness.releaseRead(); });
      await joined(page); finished = await page.evaluate(() => window.sogGroupHarness.finishReads());
    }
    const after = await snapshot(page); retained(after, before);
    expect(finished.sameActiveClient).toBe(true); expect(finished.sameActiveScene).toBe(true);
    expect(finished.heldCandidate!.sourceOwners).toBe(0); expect(finished.groups[0].metadataCredits).toEqual([null, null]);
    expect(finished.ledger.entries.filter(entry => entry.category === 'source' || entry.category === 'work'))
      .toEqual(baseline.ledger.entries.filter(entry => entry.category === 'source' || entry.category === 'work'));
    await testInfo.attach('sog-held-actual-resource-ui-cancel-joined.json', { body: JSON.stringify({ before, baseline, held, cancelled: cancelled!, after, finished }), contentType: 'application/json' });
  });

  test(caseTitle('a newer real group wins while an older actual metadata read stays held, and the old completion cannot publish late'), async ({ page }, testInfo) => {
    await page.evaluate(() => window.alignmentHarness.load('sog-kept-newer.ply'));
    let held!: ReturnType<Window['sogGroupHarness']['readObservation']>, final!: typeof held;
    let winner!: Snapshot, winning!: ReturnType<Window['sogGroupHarness']['ownership']>;
    await page.evaluate(() => window.sogGroupHarness.observeReads('meta.json'));
    try {
      await page.getByLabel('Open scene files', { exact: true }).setInputFiles(inputs());
      await expect.poll(() => page.evaluate(() => window.sogGroupHarness.readObservation().held)).toBe(true);
      held = await page.evaluate(() => window.sogGroupHarness.readObservation()); expect(held.groups).toHaveLength(0);
      await drop(page, changedExtra()); await fingerprint(page, extraKey.assetDigest);
      winner = await snapshot(page); independentRecords(winner);
      winning = await page.evaluate(() => window.sogGroupHarness.ownership()); expect(winning.pendingLoads).toBe(1); expect(winning.catalog).toEqual(['meta.json']);
    } finally {
      await page.evaluate(() => { if (!window.sogGroupHarness.readObservation().released) window.sogGroupHarness.releaseRead(); });
      await joined(page); final = await page.evaluate(() => window.sogGroupHarness.finishReads());
    }
    const after = await snapshot(page); retained(after, winner);
    expect(final.activeDocumentId).toBe(winning.activeDocumentId); expect(final.catalog).toEqual(winning.catalog); expect(final.currentFile).toBe(winning.currentFile);
    expect(final.fingerprint!.assetDigest).toBe(extraKey.assetDigest);
    await testInfo.attach('sog-newer-winner-after-old-metadata-join.json', { body: JSON.stringify({ held, winner, winning, after, final }), contentType: 'application/json' });
  });

  test(caseTitle('Escape retains real candidate GPU buffers until the held actual allocation returns and joins disposal'), async ({ page }, testInfo) => {
    await page.evaluate(() => window.alignmentHarness.load('sog-kept-gpu.ply')); const before = await snapshot(page); mirrors(before);
    let held!: ReturnType<Window['sogGroupHarness']['allocationObservation']>;
    let cancelled!: typeof held, finished!: typeof held;
    await page.evaluate(() => window.sogGroupHarness.holdAllocation());
    try {
      await page.getByLabel('Open scene files', { exact: true }).setInputFiles(inputs());
      await expect.poll(() => page.evaluate(() => window.sogGroupHarness.allocationObservation().entered)).toBe(true);
      held = await page.evaluate(() => window.sogGroupHarness.allocationObservation());
      expect(held.actualScene).toMatchObject({ count: 3, retired: false }); expect(held.actualScene!.allocationBytes).toBeGreaterThan(0);
      expect(held.buffers.length).toBeGreaterThan(0); expect(held.buffers.every(buffer => buffer.destroyCalls === 0)).toBe(true);
      await page.getByLabel('SplatView scene', { exact: true }).focus(); await page.keyboard.press('Escape');
      cancelled = await page.evaluate(() => window.sogGroupHarness.allocationObservation());
      expect(cancelled).toMatchObject({ busy: false, pendingLoads: 1, sameActiveClient: true, sameActiveScene: true, actualScene: { retired: false } });
      expect(cancelled.buffers).toEqual(held.buffers);
      retained(await snapshot(page), before, true);
    } finally {
      await page.evaluate(() => { if (!window.sogGroupHarness.allocationObservation().released) window.sogGroupHarness.releaseAllocation(); });
      await joined(page); finished = await page.evaluate(() => window.sogGroupHarness.finishAllocation());
    }
    const after = await snapshot(page); retained(after, before);
    expect(finished.actualScene!.retired).toBe(true); expect(finished.sameActiveClient).toBe(true); expect(finished.sameActiveScene).toBe(true);
    expect(finished.buffers.map(buffer => buffer.destroyCalls)).toEqual(held.buffers.map(() => 1));
    await testInfo.attach('sog-real-gpu-allocation-escape-retirement.json', { body: JSON.stringify({ before, held, cancelled: cancelled!, after, finished }), contentType: 'application/json' });
  });
}
