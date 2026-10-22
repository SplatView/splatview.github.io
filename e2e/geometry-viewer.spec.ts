import { expect, test, type Page } from '@playwright/test';
import type {} from './geometry-viewer-harness';

async function wake(page: Page) { await page.mouse.move(20, 20); await page.mouse.move(21, 21); }
test.beforeEach(async ({ page }) => {
  await page.goto('/e2e/geometry-viewer-harness.html');
  await page.waitForFunction(() => window.geometryViewerError || window.geometryViewer?.ready());
  expect(await page.evaluate(() => window.geometryViewerError)).toBeUndefined();
});

for (const source of ['points', 'mesh'] as const) {
  test(`actual App loads ${source} through native geometry streaming and fits its retained vertices`, async ({ page }, testInfo) => {
    await page.evaluate(source => window.geometryViewer.load(source), source);
    const result = await page.evaluate(() => window.geometryViewer.inspect());
    const count = source === 'points' ? 3 : 6;
    expect(result.summary.kind).toBe(source === 'points' ? 1 : 2); expect(result.summary.count).toBe(count);
    expect(result.summary.sourceCount).toBe(count); expect(result.summary.sourceFaces).toBe(source === 'points' ? 0 : 1);
    expect(result.summary.sampledGeometry).toBe(false); expect(result.summary.selected).toBe(0);
    expect(result.summary.canUndo).toBe(false); expect(result.summary.canRedo).toBe(false);
    expect(result.descriptor.vertexCount).toBe(count); expect(result.descriptor.triangleCount).toBe(source === 'points' ? 0 : 4);
    expect(result.descriptor.vertexStride).toBe(16); expect(result.descriptor.indexStride).toBe(4);
    expect(result.noGaussianBuffers).toBe(true); expect(result.editingAvailable).toBe(false);
    result.camera.slice(0, 10).forEach((value, index) => expect(value).toBeCloseTo(result.summary.camera[index], 5));
    expect(result.camera[10]).toBeCloseTo(result.capture.width / result.capture.height, 5);
    expect(result.capture.foreground).toBeGreaterThan(source === 'points' ? 10 : 1000);
    expect(result.capture.background).toEqual([0, 0, 0, 255]); expect(result.depthBytes).toBe(result.capture.width * result.capture.height * 4);
    if (source === 'points') {
      expect(result.records.map(vertex => vertex.rgba)).toEqual([[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255]]);
      result.records.map(vertex => vertex.position).forEach((point, index) => [0, 1, 2].forEach(coordinate => {
        const expected = [[-.4, 0, 0], [.4, 0, 0], [0, .4, .1]][index][coordinate]; expect(point[coordinate]).toBeCloseTo(expected, 6);
      }));
    } else {
      expect(result.area).toBe(3); expect(result.indices).toHaveLength(12);
      expect(result.centroids.every(([x, y]) => x <= 1 || y <= 1)).toBe(true);
      expect(result.records.every(vertex => vertex.rgba.join(',') === '255,180,30,255')).toBe(true);
    }
    await testInfo.attach(`${source}-native-gpu-contract.json`, { body: JSON.stringify(result), contentType: 'application/json' });
  });

  test(`${source} omits editing chrome and blocks selection/export shortcuts in the real App`, async ({ page }) => {
    await page.evaluate(source => window.geometryViewer.load(source), source); await wake(page);
    await expect(page.getByRole('button', { name: 'Save scene', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Tools', exact: true })).toHaveCount(0);
    const panel = page.getByRole('group', { name: 'Viewer panel', exact: true });
    await expect(panel.getByRole('button')).toHaveCount(1);
    await expect(panel.getByRole('button', { name: 'Settings', exact: true })).toBeEnabled();
    await expect(page.getByRole('complementary', { name: 'Tools', exact: true })).toHaveCount(0);
    const initial = await page.evaluate(() => window.geometryViewer.keyboardStart());
    await page.getByLabel('SplatView scene', { exact: true }).focus();
    for (const key of ['b', 'Shift+B', 'x', 'p', 'g', 'Delete', 'Backspace', 'ControlOrMeta+a', 'ControlOrMeta+e', 'ControlOrMeta+s', 'ControlOrMeta+z', 'ControlOrMeta+Shift+z']) await page.keyboard.press(key);
    const { calls, after } = await page.evaluate(() => window.geometryViewer.keyboardFinish());
    expect(calls).toEqual([]); expect(after.summary).toEqual(initial.summary); expect(after.capture).toEqual(initial.capture);
    expect(after.tool).toBeNull(); expect(after.exportOpen).toBe(false); expect(after.toolsOpen).toBe(false);
    expect(after.ledger).toEqual(initial.ledger); await expect(page.getByRole('dialog', { name: 'Save scene', exact: true })).toHaveCount(0);
  });

  test(`${source} refuses direct controller edit, contributor, map and output calls before native forwarding`, async ({ page }) => {
    await page.evaluate(source => window.geometryViewer.load(source), source);
    const result = await page.evaluate(() => window.geometryViewer.restrictions());
    expect(result.edits).toEqual([false, false, false, false, false, false]); expect(result.picks).toEqual({ single: null, color: false, fill: false });
    expect(result.gesture).toBe(false); expect(result.mapError).toMatch(/Wait for the current operation/);
    expect(result.forwarded).toEqual([]); expect(result.exportCalls).toBe(0); expect(result.gpuPicks).toBe(0);
    expect(result.after.summary).toEqual(result.before.summary); expect(result.after.capture).toEqual(result.before.capture);
    expect(result.after.camera).toEqual(result.before.camera); expect(result.after.grade).toEqual(result.before.grade);
    expect(result.after.ledger).toEqual(result.before.ledger);
  });

  test(`${source} keeps actual navigation, background, capture and fullscreen controls`, async ({ page }) => {
    await page.evaluate(source => window.geometryViewer.load(source), source); await wake(page);
    for (const name of ['Reset camera', 'Orbit / Look', 'Flip up', 'Narrower lens', 'Wider lens', 'Capture image', 'Copy image', 'Background', 'Fullscreen'])
      await expect(page.getByRole('button', { name, exact: true })).toBeEnabled();
    const before = await page.evaluate(() => window.geometryViewer.snapshot());
    const scene = page.getByLabel('SplatView scene', { exact: true }), bounds = (await scene.boundingBox())!;
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2); await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width / 2 + 45, bounds.y + bounds.height / 2 + 20); await page.mouse.up();
    const navigated = await page.evaluate(() => window.geometryViewer.snapshot()); expect(navigated.camera).not.toEqual(before.camera);
    await wake(page); await page.getByRole('button', { name: 'Orbit / Look', exact: true }).click(); await expect(scene).toHaveAttribute('data-navigation', 'look');
    await page.getByRole('button', { name: 'Orbit / Look', exact: true }).click(); await expect(scene).toHaveAttribute('data-navigation', 'orbit');
    await page.getByRole('button', { name: 'Flip up', exact: true }).click();
    const flipped = await page.evaluate(() => window.geometryViewer.snapshot()); expect(flipped.camera[8]).not.toBe(navigated.camera[8]);
    await page.getByRole('button', { name: 'Reset camera', exact: true }).click();
    await page.getByRole('button', { name: 'Narrower lens', exact: true }).click();
    const lens = await page.evaluate(() => window.geometryViewer.snapshot()); expect(lens.camera[7]).toBe(before.camera[7] - 5);
    await page.getByRole('button', { name: 'Background', exact: true }).click();
    const gray = await page.evaluate(() => window.geometryViewer.snapshot()); expect(gray.background).toBe('gray');
    gray.capture.background.slice(0, 3).forEach(channel => expect(Math.abs(channel - 127.5)).toBeLessThanOrEqual(1));
    await wake(page); const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Capture image', exact: true }).click();
    expect((await download).suggestedFilename()).toBe('SplatView.jpg');
    await page.getByRole('button', { name: 'Reset camera', exact: true }).click();
    const reset = await page.evaluate(() => window.geometryViewer.snapshot()); expect(reset.camera).toEqual(before.camera); expect(reset.background).toBe('black');
    await page.getByRole('button', { name: 'Fullscreen', exact: true }).click(); await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true);
    await wake(page); await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).click(); await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(false);
    const after = await page.evaluate(() => window.geometryViewer.snapshot()); expect(after.summary).toEqual(before.summary);
    expect(after.dirty).toBe(false); await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test(`${source} actual graphics loss rebuilds the same native document and view`, async ({ page }, testInfo) => {
    const result = await page.evaluate(source => window.geometryViewer.recover(source), source);
    expect(result.sameClient).toBe(true); expect(result.replacedScene).toBe(true); expect(result.replacedRenderer).toBe(true); expect(result.oldRetired).toBe(true);
    expect(result.after.deviceEpoch).toBeGreaterThan(result.before.deviceEpoch); expect(result.after.summary).toEqual(result.before.summary);
    expect(result.after.camera).toEqual(result.before.camera); expect(result.after.cameraBackground).toBe(result.before.cameraBackground);
    expect(result.after.capture).toEqual(result.before.capture); expect(result.after.sourceName).toBe(result.before.sourceName);
    expect(result.after.sourceFiles).toEqual(result.before.sourceFiles); expect(result.after.sourceIndex).toBe(result.before.sourceIndex);
    expect(result.after.ledger).toEqual(result.before.ledger); expect(result.after.depthBytes).toBe(result.before.depthBytes);
    expect(result.commands.every(command => command === 'summary')).toBe(true); expect(result.error).toBeNull();
    await testInfo.attach(`${source}-device-recovery.json`, { body: JSON.stringify(result), contentType: 'application/json' });
  });
}

test('Gaussian to geometry to Gaussian source publication resets stale editing presentation', async ({ page }) => {
  const result = await page.evaluate(() => window.geometryViewer.transitions());
  expect(result.geometry.summary.kind).toBe(2); expect(result.geometry.toolsOpen).toBe(false); expect(result.geometry.tool).toBeNull();
  expect(result.geometry.exportOpen).toBe(false); expect(result.geometry.grade).toEqual(result.gaussian.grade);
  expect(result.gaussian.summary.kind).toBe(0); expect(result.gaussian.summary.selected).toBe(0);
  expect(result.gaussian.summary.canUndo).toBe(false); expect(result.gaussian.summary.canRedo).toBe(false);
  expect(result.gaussian.depthBytes).toBe(0); expect(result.gaussian.toolsOpen).toBe(false); expect(result.gaussian.tool).toBeNull();
  expect(result.editingAvailable).toBe(true); await wake(page);
  await expect(page.getByRole('button', { name: 'Save scene', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Tools', exact: true })).toBeEnabled();
});

for (const kind of ['malformed', 'budget', 'gpu', 'cancel'] as const) test(`${kind} geometry replacement preserves an edited Gaussian and its Redo authority`, async ({ page }, testInfo) => {
  const result = await page.evaluate(kind => window.geometryViewer.replacementFailure(kind), kind);
  expect(result.before.dirty).toBe(true); expect(result.before.summary.canRedo).toBe(true);
  expect(result.sameClient).toBe(true); expect(result.sameScene).toBe(true); expect(result.sameRenderer).toBe(true);
  for (const key of ['summary', 'capture', 'exported', 'gpuMasks', 'camera', 'cameraBackground', 'sourceName', 'sourceIndex', 'sourceFiles', 'dirty', 'ledger', 'depthBytes'] as const)
    expect(result.after[key], key).toEqual(result.before[key]);
  if (kind === 'cancel') {
    expect(result.afterCancel).not.toBeNull(); expect(result.afterCancel!.settled).toBe(false);
    expect(result.afterCancel!.sameClient).toBe(true); expect(result.afterCancel!.sameScene).toBe(true); expect(result.afterCancel!.candidateDisposed).toBe(true);
    expect(result.afterCancel!.held).toEqual(result.afterCancel!.admitted); expect(result.afterCancel!.held.bytes).toBeGreaterThan(result.before.ledger.bytes);
    expect(result.uploadCalls).toBe(1); expect(result.error).toBeNull();
  } else expect(result.error).toMatch(kind === 'malformed' ? /index|mesh|face/i : kind === 'budget' ? /budget/i : /usage|buffer/i);
  expect(result.redone).toBe(true); expect(result.afterRedo.summary.canRedo).toBe(false);
  expect(result.afterRedo.exported).not.toBe(result.before.exported); expect(result.settled).toBe(true);
  await testInfo.attach(`${kind}-replacement-preservation.json`, { body: JSON.stringify(result), contentType: 'application/json' });
});

test('stationary App geometry resize schedules the checked target redraw without user input', async ({ page }) => {
  await page.evaluate(() => window.geometryViewer.load('mesh'));
  const before = await page.evaluate(() => window.geometryViewer.snapshot());
  let previous = -1, stableSince = 0;
  await expect.poll(async () => {
    const state = await page.evaluate(() => window.geometryViewer.renderState());
    if (state.frames !== previous) { previous = state.frames; stableSince = Date.now(); return false; }
    return Date.now() - stableSince >= 250;
  }, { timeout: 5_000, intervals: [25, 50] }).toBe(true);
  const frame = (await page.evaluate(() => window.geometryViewer.renderState())).frames;
  await page.evaluate(() => window.geometryViewer.resize(641));
  await expect.poll(async () => {
    const result = await page.evaluate(() => window.geometryViewer.renderState());
    return result.frames > frame && result.depthBytes === result.width * result.height * 4 && result.width === 641;
  }).toBe(true);
  const after = await page.evaluate(() => window.geometryViewer.snapshot()); expect(after.capture.foreground).toBeGreaterThan(1000);
  expect(after.summary).toEqual(before.summary); expect(after.camera.slice(0, 10)).toEqual(before.camera.slice(0, 10));
  expect(after.sourceName).toBe(before.sourceName); expect(after.ledger.allocations).toBe(before.ledger.allocations);
});

test('controller disposal retains native, geometry and depth leases through the actual GPU retirement fence', async ({ page }) => {
  const result = await page.evaluate(() => window.geometryViewer.disposeRetirement());
  expect(result.during.retired).toBe(true); expect(result.noGaussianBuffers).toBe(true);
  expect(result.during.nativeRetirementCalls).toBe(0); expect(result.nativeRetirementCalls).toBe(1);
  // Browser recovery snapshots have no GPU borrower in this idle fixture and
  // retire immediately. Every native/render owner must outlive the held fence.
  const recovery = result.before.ledger.entries.filter(entry => entry.category === 'recovery');
  expect(recovery).toHaveLength(1); expect(recovery[0].bytes).toBeGreaterThan(0);
  expect(result.during.ledger).toEqual({
    entries: result.before.ledger.entries.filter(entry => entry.category !== 'recovery'),
    bytes: result.before.ledger.bytes - recovery[0].bytes,
    allocations: result.before.ledger.allocations - 1,
  });
  expect(result.during.depthBytes).toBe(result.before.depthBytes);
  expect(result.during.ledger.bytes).toBeGreaterThan(result.during.depthBytes);
  expect(result.after).toEqual({ bytes: 0, allocations: 0, entries: [] }); expect(result.depthAfter).toBe(0);
});
