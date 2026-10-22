import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import type {} from './geometry-viewer-harness';
import { gaussianPly } from '../tests/fixtures/gaussians';

// Independent, literal input: these tests exercise the mounted App and its real
// worker, native loader, GPU upload and public navigation methods.
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
const malformedMesh = `ply
format ascii 1.0
element vertex 3
property float x
property float y
property float z
element face 1
property list uchar int vertex_indices
end_header
0 0 0
1 0 0
0 1 0
3 0 1 99
`;
const winnerPoints = points.replace('-.4 0 0 255 0 0', '-.6 0 0 255 0 0');
function fingerprint(input: string | Uint8Array, sourceKindHint: 'PLY point cloud' | 'PLY' = 'PLY point cloud') {
  const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input);
  // Independent SHA-256 and literal 69-byte v1 single-file table. Names and
  // decoder/editor output are deliberately absent from source identity.
  const table = Buffer.alloc(69); table.write('SplatViewSource\0v1\0', 0, 'utf8');
  table.writeUInt32BE(1, 20); table[24] = 1; table.writeBigUInt64BE(BigInt(bytes.length), 29);
  createHash('sha256').update(bytes).digest().copy(table, 37);
  return { scheme: 'splatview-source-v1', resourceCount: 1, totalBytes: bytes.length,
    assetDigest: createHash('sha256').update(table).digest('hex'), sourceKindHint };
}

test.beforeEach(async ({ page }) => {
  await page.goto('/e2e/geometry-viewer-harness.html');
  await page.waitForFunction(() => window.geometryViewerError || window.geometryViewer?.ready());
  expect(await page.evaluate(() => window.geometryViewerError)).toBeUndefined();
});

for (const olderAction of ['collection', 'adjacent'] as const) {
  test(`a newer source keeps its catalog and index after an older ${olderAction} finishes retirement`, async ({ page }, testInfo) => {
    const result = await page.evaluate(async ({ points, winnerPoints, olderAction }) => {
      const app = window.geometryViewer.controllerForSourceNavigation();
      const files = (names: string[], content = points) => names.map(name => new File([content], name));
      await app.openFiles(files(['c-base.ply', 'a-base.ply', 'b-base.ply']));
      await app.adjacent(1);
      const initial = await window.geometryViewer.snapshot();
      const oldScene = app.scene!, queue = app.renderer!.device.queue;
      const originalDispose = oldScene.dispose.bind(oldScene), originalFence = queue.onSubmittedWorkDone.bind(queue);
      let enter!: () => void, release!: () => void, olderSettled = false;
      const entered = new Promise<void>(resolve => { enter = resolve; });
      const held = new Promise<void>(resolve => { release = resolve; });
      // Hold the actual old-scene fence. Restore the queue method immediately
      // after dispose starts, so successor preparation uses genuine GPU fences.
      oldScene.dispose = () => {
        queue.onSubmittedWorkDone = async () => { await originalFence(); await held; };
        try { const retirement = originalDispose(); enter(); return retirement; }
        finally { queue.onSubmittedWorkDone = originalFence; }
      };
      const older = (olderAction === 'collection'
        ? app.openFiles(files(['b-older.ply', 'a-older.ply'])) : app.adjacent(1))
        .then(() => { olderSettled = true; });
      try {
        await entered;
        const during = await window.geometryViewer.snapshot();
        const heldOwner = { olderSettled, retired: oldScene.retired };
        await app.openFiles(files(['c-winner.ply', 'a-winner.ply', 'b-winner.ply'], winnerPoints));
        await app.adjacent(1);
        const winnerScene = app.scene, winnerClient = app.client;
        const beforeRelease = await window.geometryViewer.snapshot();
        release(); await older;
        const afterRelease = await window.geometryViewer.snapshot();
        const sameWinner = app.scene === winnerScene && app.client === winnerClient;
        await app.adjacent(1);
        return { initial, during, heldOwner, beforeRelease, afterRelease, sameWinner,
          afterNext: await window.geometryViewer.snapshot() };
      } finally { release(); oldScene.dispose = originalDispose; queue.onSubmittedWorkDone = originalFence; await older; }
    }, { points, winnerPoints, olderAction });
    const olderNames = olderAction === 'collection' ? ['a-older.ply', 'b-older.ply'] : ['a-base.ply', 'b-base.ply', 'c-base.ply'];
    const olderIndex = olderAction === 'collection' ? 0 : 2;
    expect(result.heldOwner).toEqual({ olderSettled: false, retired: true });
    expect(result.initial.sourceFingerprint).toEqual(fingerprint(points));
    expect(result.during.sourceFingerprint).toEqual(fingerprint(points));
    expect(result.during.sourceFiles).toEqual(olderNames); expect(result.during.sourceIndex).toBe(olderIndex);
    expect(result.during.sourceName).toBe(olderNames[olderIndex]);
    for (const state of [result.beforeRelease, result.afterRelease]) {
      expect(state.sourceFiles).toEqual(['a-winner.ply', 'b-winner.ply', 'c-winner.ply']);
      expect(state.sourceIndex).toBe(1); expect(state.sourceName).toBe('b-winner.ply');
      expect(state.sourceFingerprint).toEqual(fingerprint(winnerPoints));
    }
    expect(result.sameWinner).toBe(true);
    expect(result.afterRelease.summary).toEqual(result.beforeRelease.summary);
    expect(result.afterRelease.capture).toEqual(result.beforeRelease.capture);
    expect(result.afterRelease.camera).toEqual(result.beforeRelease.camera);
    expect(result.afterRelease.ledger.bytes).toBeLessThan(result.beforeRelease.ledger.bytes);
    expect(result.afterNext.sourceFiles).toEqual(['a-winner.ply', 'b-winner.ply', 'c-winner.ply']);
    expect(result.afterNext.sourceIndex).toBe(2); expect(result.afterNext.sourceName).toBe('c-winner.ply');
    expect(result.afterNext.sourceFingerprint).toEqual(fingerprint(winnerPoints));
    expect(result.afterRelease.sourceFingerprint).not.toEqual(result.initial.sourceFingerprint);
    await testInfo.attach(`source-${olderAction}-retirement.json`, { body: JSON.stringify(result), contentType: 'application/json' });
  });
}

test('empty, unsupported and native-invalid replacements preserve the current nonzero catalog position', async ({ page }) => {
  const result = await page.evaluate(async ({ points, malformedMesh }) => {
    const app = window.geometryViewer.controllerForSourceNavigation();
    await app.openFiles(['c-kept.ply', 'a-kept.ply', 'b-kept.ply'].map(name => new File([points], name)));
    await app.adjacent(1);
    const scene = app.scene, client = app.client, before = await window.geometryViewer.snapshot(), attempts = [];
    for (const replacement of [[], [new File(['unrelated'], 'notes.txt')], [new File([malformedMesh], 'broken.ply')]]) {
      await app.openFiles(replacement);
      attempts.push({ state: await window.geometryViewer.snapshot(), sameScene: app.scene === scene, sameClient: app.client === client });
    }
    await app.adjacent(1);
    return { before, attempts, afterNext: await window.geometryViewer.snapshot() };
  }, { points, malformedMesh });
  expect(result.before.sourceIndex).toBe(1); expect(result.before.sourceName).toBe('b-kept.ply');
  expect(result.before.sourceFingerprint).toEqual(fingerprint(points));
  for (const attempt of result.attempts) {
    expect(attempt.sameScene).toBe(true); expect(attempt.sameClient).toBe(true);
    expect(attempt.state.sourceFiles).toEqual(['a-kept.ply', 'b-kept.ply', 'c-kept.ply']);
    expect(attempt.state.sourceIndex).toBe(1); expect(attempt.state.sourceName).toBe('b-kept.ply');
    expect(attempt.state.summary).toEqual(result.before.summary); expect(attempt.state.capture).toEqual(result.before.capture);
    expect(attempt.state.camera).toEqual(result.before.camera); expect(attempt.state.ledger).toEqual(result.before.ledger);
    expect(attempt.state.sourceFingerprint).toEqual(fingerprint(points));
  }
  expect(result.afterNext.sourceIndex).toBe(2); expect(result.afterNext.sourceName).toBe('c-kept.ply');
  expect(result.afterNext.sourceFiles).toEqual(['a-kept.ply', 'b-kept.ply', 'c-kept.ply']);
  expect(result.afterNext.sourceFingerprint).toEqual(fingerprint(points));
});

test('canceling an actual held input read preserves the current catalog and position', async ({ page }) => {
  const result = await page.evaluate(async ({ points, winnerPoints }) => {
    const app = window.geometryViewer.controllerForSourceNavigation();
    await app.openFiles(['a-kept.ply', 'b-kept.ply', 'c-kept.ply'].map(name => new File([points], name)));
    await app.adjacent(1);
    const before = await window.geometryViewer.snapshot(), scene = app.scene, client = app.client;
    const candidate = new File([winnerPoints], 'cancelled.ply'), originalSlice = candidate.slice.bind(candidate);
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    candidate.slice = (...args) => {
      const blob = originalSlice(...args), read = blob.arrayBuffer.bind(blob);
      blob.arrayBuffer = async () => { const bytes = await read(); enter(); await held; return bytes; };
      return blob;
    };
    const opening = app.openFiles([candidate]);
    try {
      await entered; app.cancelLoad();
      const during = await window.geometryViewer.snapshot();
      release(); await opening;
      const after = await window.geometryViewer.snapshot(), sameScene = app.scene === scene, sameClient = app.client === client;
      await app.adjacent(1);
      return { before, during, after, sameScene, sameClient, afterNext: await window.geometryViewer.snapshot() };
    } finally { release(); candidate.slice = originalSlice; await opening; }
  }, { points, winnerPoints });
  expect(result.sameScene).toBe(true); expect(result.sameClient).toBe(true);
  expect(result.before.sourceFingerprint).toEqual(fingerprint(points));
  for (const state of [result.during, result.after]) {
    expect(state.sourceFiles).toEqual(['a-kept.ply', 'b-kept.ply', 'c-kept.ply']);
    expect(state.sourceIndex).toBe(1); expect(state.sourceName).toBe('b-kept.ply');
    expect(state.summary).toEqual(result.before.summary); expect(state.capture).toEqual(result.before.capture);
    expect(state.sourceFingerprint).toEqual(fingerprint(points));
  }
  expect(result.during.ledger.bytes).toBeGreaterThan(result.before.ledger.bytes);
  expect(result.after.ledger).toEqual(result.before.ledger);
  expect(result.afterNext.sourceIndex).toBe(2); expect(result.afterNext.sourceName).toBe('c-kept.ply');
  expect(result.afterNext.sourceFingerprint).toEqual(fingerprint(points));
});

test('acquisition snapshots the caller array and publishes a frozen catalog', async ({ page }) => {
  const result = await page.evaluate(async points => {
    const app = window.geometryViewer.controllerForSourceNavigation();
    const input = ['b-snapshot.ply', 'a-snapshot.ply'].map(name => new File([points], name));
    const opening = app.openFiles(input); input.splice(0, input.length, new File([points], 'mutated.ply'));
    await opening;
    const catalog = (app as unknown as { files: readonly File[] }).files;
    const first = await window.geometryViewer.snapshot(); await app.adjacent(1);
    return { frozen: Object.isFrozen(catalog), first, next: await window.geometryViewer.snapshot() };
  }, points);
  expect(result.frozen).toBe(true);
  expect(result.first.sourceFiles).toEqual(['a-snapshot.ply', 'b-snapshot.ply']);
  expect(result.first.sourceIndex).toBe(0); expect(result.first.sourceName).toBe('a-snapshot.ply');
  expect(result.first.sourceFingerprint).toEqual(fingerprint(points));
  expect(result.next.sourceFiles).toEqual(['a-snapshot.ply', 'b-snapshot.ply']);
  expect(result.next.sourceIndex).toBe(1); expect(result.next.sourceName).toBe('b-snapshot.ply');
  expect(result.next.sourceFingerprint).toEqual(fingerprint(points));
});

test('disposing releases the source catalog, index and deferred navigation before GPU retirement completes', async ({ page }) => {
  const result = await page.evaluate(async gaussian => {
    const app = window.geometryViewer.controllerForSourceNavigation();
    await app.openFiles(['b-close.ply', 'a-close.ply'].map(name => new File([gaussian], name)));
    await app.adjacent(1);
    if (!await app.command({ command: 'grade', values: [1.2, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], selectedOnly: false }))
      throw new Error('The actual native edit did not create dirty navigation.');
    await app.openFiles([new File(['deferred'], 'deferred.ply')]);
    const internals = app as unknown as { files: readonly File[]; currentFile: number; pendingNavigation?: () => Promise<void> };
    const before = { names: internals.files.map(file => file.name), index: internals.currentFile,
      pending: !!internals.pendingNavigation, fingerprint: app.sourceFingerprint };
    const scene = app.scene!, renderer = app.renderer!, queue = renderer.device.queue;
    const original = queue.onSubmittedWorkDone.bind(queue), actual = original();
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    queue.onSubmittedWorkDone = async () => { await actual; await held; };
    try {
      app.dispose(); const retirement = scene.dispose(); queue.onSubmittedWorkDone = original;
      const during = { names: internals.files.map(file => file.name), index: internals.currentFile,
        pending: !!internals.pendingNavigation, frozen: Object.isFrozen(internals.files), retired: scene.retired,
        fingerprint: app.sourceFingerprint ?? null };
      await app.adjacent(1);
      release(); await retirement; await Promise.resolve();
      return { before, during, after: { names: internals.files.map(file => file.name), index: internals.currentFile,
        pending: !!internals.pendingNavigation, sceneMissing: !app.scene, fingerprint: app.sourceFingerprint ?? null } };
    } finally { release(); queue.onSubmittedWorkDone = original; }
  }, gaussianPly(0));
  expect(result.before).toEqual({ names: ['a-close.ply', 'b-close.ply'], index: 1, pending: true, fingerprint: fingerprint(gaussianPly(0), 'PLY') });
  expect(result.during).toEqual({ names: [], index: 0, pending: false, frozen: true, retired: true, fingerprint: null });
  expect(result.after).toEqual({ names: [], index: 0, pending: false, sceneMissing: true, fingerprint: null });
});
