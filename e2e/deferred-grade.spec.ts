import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import type { SelectionTool } from '../src/app/store';
import type {} from './deferred-grade-harness';

type Snapshot = Awaited<ReturnType<Window['deferredGrade']['snapshot']>>;
type State = ReturnType<Window['deferredGrade']['state']>;
const scene = (page: Page) => page.getByLabel('SplatView scene', { exact: true });
const snapshot = (page: Page) => page.evaluate(() => window.deferredGrade.snapshot());
const viewSnapshot = (page: Page) => page.evaluate(() => window.deferredGrade.viewSnapshot());
const state = (page: Page) => page.evaluate(() => window.deferredGrade.state());
const selectionNames = ['beginSelection', 'single', 'brush', 'volume', 'rectangle', 'polygon', 'colorPick', 'fillPick', 'confirmSelection'];
const selection = (value: State) => value.calls.filter(call => selectionNames.includes(call.command.command));
function exact(value: Pick<Snapshot, 'ids' | 'gpu' | 'summary'> & { records: readonly unknown[] }, ids: number[]) {
  expect(value.ids).toEqual(ids); expect(value.gpu).toEqual([0, 1, 2, 3].map(id => Number(ids.includes(id))));
  expect(value.summary.selected).toBe(ids.length); expect(value.records).toHaveLength(4);
}
function positionAndCamera(before: Snapshot, after: Snapshot) {
  expect(after.records.map(record => record.slice(0, 3))).toEqual(before.records.map(record => record.slice(0, 3)));
  expect(after.camera).toEqual(before.camera); expect(after.sourceFingerprint).toEqual(before.sourceFingerprint);
  expect(after.revision.documentId).toBe(before.revision.documentId); expect(after.revision.sourceGeneration).toBe(before.revision.sourceGeneration);
}
function order(value: State) {
  const grade = value.calls.findIndex(call => call.command.command === 'grade');
  const endColor = value.calls.findIndex(call => call.command.command === 'endColor');
  const firstSelection = value.calls.findIndex(call => selectionNames.includes(call.command.command));
  expect(grade).toBeGreaterThanOrEqual(0); expect(endColor).toBeGreaterThan(grade); expect(firstSelection).toBeGreaterThan(endColor);
  expect(value.calls[grade]).toMatchObject({ completed: true, failed: false });
  expect(value.calls[endColor]).toMatchObject({ completed: true, failed: false });
}
async function open(page: Page, tool: SelectionTool = 'single', live = false) {
  await page.goto('/e2e/deferred-grade-harness.html');
  await expect.poll(() => page.evaluate(() => window.deferredGrade?.ready() ?? false)).toBe(true);
  await page.evaluate(({ tool, live }) => window.deferredGrade.load(tool, live), { tool, live });
  await scene(page).focus(); const before = await snapshot(page); exact(before, [0]);
  const centers = await page.evaluate(() => window.deferredGrade.centers());
  await page.evaluate(() => window.deferredGrade.clear());
  return { before, centers };
}
async function hold(page: Page) {
  await page.evaluate(() => window.deferredGrade.hold());
  await expect.poll(() => state(page)).toMatchObject({ busy: true, held: true });
}
async function release(page: Page) {
  const accepted = await page.evaluate(() => window.deferredGrade.release());
  await page.evaluate(() => window.deferredGrade.settle()); return accepted;
}
async function click(page: Page, point: number[]) { await page.mouse.click(point[0], point[1]); }
async function retainedWhileHeld(page: Page, before: Snapshot) {
  const value = await state(page); expect(value.held).toBe(true); expect(value.busy).toBe(true);
  expect(selection(value)).toEqual([]); expect(await page.evaluate(() => window.deferredGrade.gpu())).toEqual(before.gpu);
  expect(value.camera).toEqual(before.camera); expect(value.sourceFingerprint).toEqual(before.sourceFingerprint);
}
async function undo(page: Page) { return page.evaluate(() => window.deferredGrade.command({ command: 'undo' })); }
async function redo(page: Page) { return page.evaluate(() => window.deferredGrade.command({ command: 'redo' })); }
async function blur(page: Page, context: BrowserContext) {
  const outside = await context.newPage(), session = await context.newCDPSession(page), other = await context.newCDPSession(outside);
  try {
    // Disable Playwright's per-page focus emulation so this is a trusted browser
    // window blur, rather than a dispatched DOM event.
    await session.send('Emulation.setFocusEmulationEnabled', { enabled: false });
    await other.send('Emulation.setFocusEmulationEnabled', { enabled: false });
    await outside.goto('about:blank'); await page.bringToFront();
    await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true);
    await outside.bringToFront(); await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(false);
    await expect.poll(async () => (await state(page)).blurs).toBeGreaterThan(0);
    await page.bringToFront(); await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true);
  } finally {
    await Promise.all([session.send('Emulation.setFocusEmulationEnabled', { enabled: true }),
      other.send('Emulation.setFocusEmulationEnabled', { enabled: true })]);
    await Promise.all([session.detach(), other.detach()]); await outside.close();
  }
}

for (const live of [false, true]) test(`real manual grade retains a completed ${live ? 'live' : 'deferred'} Single and orders native Undo and Redo`, async ({ page }) => {
  const { before, centers } = await open(page, 'single', live); await hold(page); await click(page, centers[1]);
  await retainedWhileHeld(page, before); expect(await release(page)).toBe(true);
  const after = await snapshot(page); exact(after, [1]); positionAndCamera(before, after); order(after);
  expect(after.summary.selectionDraft).toBe(false); expect(after.allBytes).not.toEqual(before.allBytes);
  expect(after.colorSession?.active ?? false).toBe(false); expect(after.error).toBeNull();
  const selected = await undo(page); exact(selected, [0]); expect(selected.allBytes).toEqual(after.allBytes);
  const original = await undo(page); exact(original, [0]); expect(original.allBytes).toEqual(before.allBytes);
  const graded = await redo(page); exact(graded, [0]); expect(graded.allBytes).toEqual(after.allBytes);
  const restored = await redo(page); exact(restored, [1]); expect(restored.allBytes).toEqual(after.allBytes);
  expect(restored.summary.canRedo).toBe(false); expect(restored.error).toBeNull();
});

test('genuine native Auto Exposure retains a physical Single until its color boundary and preserves Undo and Redo order', async ({ page }) => {
  const { before, centers } = await open(page, 'single', true);
  await page.evaluate(() => window.deferredGrade.holdAuto());
  await expect.poll(() => state(page)).toMatchObject({ busy: true, held: true });
  await click(page, centers[1]); await retainedWhileHeld(page, before);
  expect(await page.evaluate(() => window.deferredGrade.releaseAuto())).toBe(true);
  await page.evaluate(() => window.deferredGrade.settle()); const after = await snapshot(page); exact(after, [1]); positionAndCamera(before, after);
  const automatic = after.calls.findIndex(call => call.command.command === 'autoColor');
  const boundary = after.calls.findIndex(call => call.command.command === 'endColor');
  const firstSelection = after.calls.findIndex(call => selectionNames.includes(call.command.command));
  expect(automatic).toBeGreaterThanOrEqual(0); expect(boundary).toBeGreaterThan(automatic); expect(firstSelection).toBeGreaterThan(boundary);
  expect(after.calls[automatic]).toMatchObject({ command: { method: 'exposure' }, completed: true, failed: false });
  expect(after.calls.filter(call => call.command.command === 'autoColor')).toHaveLength(1);
  expect(after.calls.filter(call => call.command.command === 'grade')).toHaveLength(0);
  // The sole selected literal RGB (.85, .15, .15) has luminance .3593.
  // Native Exposure targets .45, so this fixture creates a real color edit.
  expect(after.calls[automatic].result!.contentRevision).toBeGreaterThan(before.summary.contentRevision);
  expect(after.allBytes).not.toEqual(before.allBytes); expect(after.records[0]).not.toEqual(before.records[0]);
  expect(after.records.slice(1)).toEqual(before.records.slice(1)); expect(after.colorSession?.active ?? false).toBe(false);
  expect(after).toMatchObject({ captured: false, dragging: false, draft: false, active: false, error: null });
  const selected = await undo(page); exact(selected, [0]); expect(selected.allBytes).toEqual(after.allBytes);
  const original = await undo(page); exact(original, [0]); expect(original.allBytes).toEqual(before.allBytes);
  const colored = await redo(page); exact(colored, [0]); expect(colored.allBytes).toEqual(after.allBytes);
  const restored = await redo(page); exact(restored, [1]); expect(restored.allBytes).toEqual(after.allBytes);
  expect(restored.summary.canRedo).toBe(false); expect(restored.error).toBeNull();
});

test('Brush replays every physical path point with each press radius and captured defaults', async ({ page }) => {
  const { before, centers } = await open(page, 'brush'); await hold(page);
  await page.mouse.move(centers[0][0], centers[0][1]); await page.mouse.down();
  await page.mouse.move(centers[3][0], centers[3][1], { steps: 5 }); await page.mouse.up();
  await page.evaluate(() => { window.deferredGrade.brushSize(48); window.deferredGrade.defaults({ operation: 1, overlap: true, visibleOnly: true, live: true }); });
  await page.keyboard.down('Shift'); await click(page, centers[2]); await page.keyboard.up('Shift');
  await page.evaluate(() => { window.deferredGrade.brushSize(96); window.deferredGrade.defaults({ operation: 2, overlap: false, visibleOnly: false, live: false }); });
  await retainedWhileHeld(page, before); expect(await release(page)).toBe(true);
  const after = await snapshot(page); exact(after, [0, 2, 3]); positionAndCamera(before, after); order(after);
  const raw: number[][][] = []; let path: number[][] | undefined;
  for (const pointer of after.pointers) {
    if (pointer.type === 'pointerdown' && pointer.button === 0) { path = [[pointer.x, pointer.y]]; raw.push(path); }
    else if (pointer.type === 'pointermove' && pointer.buttons & 1) path?.push([pointer.x, pointer.y]);
    else if (pointer.type === 'pointerup' && pointer.button === 0) { path?.push([pointer.x, pointer.y]); path = undefined; }
  }
  expect(raw).toHaveLength(2); expect(raw[0]).toHaveLength(7);
  const brushes = selection(after).filter(call => call.command.command === 'brush');
  for (const [index, operation, radius, overlap, visibleOnly] of [[0, 0, 8, false, false], [1, 1, 24, true, true]] as const) {
    const final = brushes.filter(call => call.command.operation === operation && call.command.radius === radius)
      .sort((a, b) => (b.command.points as number[][]).length - (a.command.points as number[][]).length)[0];
    expect(final).toBeDefined(); expect(final.command.points).toEqual(raw[index]);
    expect(final.command).toMatchObject({ operation, radius, overlap, visibleOnly });
  }
  expect(after.pointers.filter(pointer => pointer.type === 'pointerdown' || pointer.type === 'pointerup').every(pointer => pointer.trusted && pointer.targetCanvas)).toBe(true);
  const first = await undo(page); exact(first, [0, 3]); expect(first.allBytes).toEqual(after.allBytes);
  const baseline = await undo(page); exact(baseline, [0]); expect(baseline.allBytes).toEqual(after.allBytes);
  exact(await redo(page), [0, 3]); exact(await redo(page), [0, 2, 3]);
});

test('Rectangle preserves its outside release through real pointer capture and commits only after grade', async ({ page }) => {
  const { before, centers } = await open(page, 'rectangle', true); await hold(page);
  await page.mouse.move(centers[2][0] - 12, centers[2][1] - 12); await page.mouse.down();
  await expect.poll(() => state(page)).toMatchObject({ captured: true });
  await page.mouse.move(1308, centers[1][1] + 12, { steps: 4 }); await page.mouse.up();
  await retainedWhileHeld(page, before); expect(await release(page)).toBe(true);
  const after = await snapshot(page); exact(after, [1, 2]); order(after); positionAndCamera(before, after);
  const down = after.pointers.find(pointer => pointer.type === 'pointerdown')!, up = after.pointers.find(pointer => pointer.type === 'pointerup')!;
  expect(up).toMatchObject({ trusted: true, targetCanvas: true }); expect(up.x).toBeGreaterThan(after.framebuffer[0]);
  expect(selection(after).filter(call => call.command.command === 'rectangle').some(call =>
    JSON.stringify(call.command.rectangle) === JSON.stringify([down.x, down.y, up.x, up.y]))).toBe(true);
  expect(after.captured).toBe(false); expect(after.dragging).toBe(false); expect(after.draft).toBe(false);
  exact(await undo(page), [0]); exact(await redo(page), [1, 2]);
});

test('released Single presses preserve physical Shift and Ctrl operations in FIFO order', async ({ page }) => {
  const { before, centers } = await open(page); await hold(page);
  await page.keyboard.down('Shift'); await click(page, centers[1]); await page.keyboard.up('Shift');
  await page.keyboard.down('ControlOrMeta'); await click(page, centers[0]); await page.keyboard.up('ControlOrMeta');
  await page.keyboard.down('ControlOrMeta'); await page.keyboard.down('Shift'); await click(page, centers[2]);
  await page.keyboard.up('Shift'); await page.keyboard.up('ControlOrMeta'); await click(page, centers[3]);
  await retainedWhileHeld(page, before); expect(await release(page)).toBe(true);
  const after = await snapshot(page); exact(after, [3]); order(after); positionAndCamera(before, after);
  expect(selection(after).filter(call => call.command.command === 'single').map(call => [call.command.index, call.command.operation]))
    .toEqual([[1, 1], [0, 2], [2, 3], [3, 0]]);
  exact(await undo(page), []); exact(await undo(page), [1]); exact(await undo(page), [0, 1]); exact(await undo(page), [0]);
  exact(await redo(page), [0, 1]); exact(await redo(page), [1]); exact(await redo(page), []); exact(await redo(page), [3]);
});

test('an older replayed release cannot release a newer physically held Single capture', async ({ page }) => {
  const { before, centers } = await open(page, 'single', true); await hold(page); await click(page, centers[1]);
  await page.mouse.move(centers[2][0], centers[2][1]); await page.mouse.down();
  await retainedWhileHeld(page, before); await expect.poll(() => state(page)).toMatchObject({ captured: true, dragging: true });
  expect(await page.evaluate(() => window.deferredGrade.release())).toBe(true);
  await expect.poll(() => state(page)).toMatchObject({ busy: false, captured: true, dragging: true, draft: true, selected: 1 });
  await expect.poll(async () => (await viewSnapshot(page)).ids).toEqual([2]);
  const held = await state(page), lastDown = held.pointers.findLastIndex(pointer => pointer.type === 'pointerdown');
  expect(held.pointers.slice(lastDown + 1).filter(pointer => pointer.type === 'lostpointercapture')).toEqual([]);
  const published = await viewSnapshot(page); exact(published, [2]); expect(published.draft).toBe(true);
  expect(published.nativeMasks).toEqual(published.gpu); expect(published.gpuViewBytes).toEqual(published.nativeViewBytes);
  const cancellations = held.calls.filter(call => call.command.command === 'cancelSelection' && call.completed && !call.failed).length;
  await page.mouse.move(centers[2][0] + 6, centers[2][1]);
  await expect.poll(async () => (await state(page)).calls.filter(call =>
    call.command.command === 'cancelSelection' && call.completed && !call.failed).length).toBe(cancellations + 1);
  await expect.poll(() => state(page)).toMatchObject({ busy: false, captured: true, dragging: true, draft: false, active: false, error: null });
  const rolledBack = await viewSnapshot(page); exact(rolledBack, [1]); expect(rolledBack.nativeViewBytes).toEqual(published.nativeViewBytes);
  expect(rolledBack.nativeMasks).toEqual(rolledBack.gpu); expect(rolledBack.gpuViewBytes).toEqual(rolledBack.nativeViewBytes);
  const acknowledgement = rolledBack.calls.filter(call => call.command.command === 'cancelSelection').at(-1)!;
  expect(acknowledgement).toMatchObject({ completed: true, failed: false,
    result: { selected: 1, selectionDraft: false, contentRevision: published.summary.contentRevision } });
  expect(rolledBack.pointers.slice(lastDown + 1).filter(pointer => pointer.type === 'lostpointercapture')).toEqual([]);
  await page.mouse.move(centers[2][0] + 3, centers[2][1]); await page.mouse.up();
  await page.evaluate(() => window.deferredGrade.settle()); const after = await snapshot(page); exact(after, [2]); order(after);
  const finalView = await viewSnapshot(page); exact(finalView, [2]); expect(finalView.nativeViewBytes).toEqual(published.nativeViewBytes);
  expect(finalView.nativeMasks).toEqual(finalView.gpu); expect(finalView.gpuViewBytes).toEqual(finalView.nativeViewBytes);
  expect(after).toMatchObject({ captured: false, dragging: false, draft: false, active: false, error: null });
  exact(await undo(page), [1]); exact(await redo(page), [2]);
});

test('live Single threshold rollback and reentry preserve the later deferred FIFO release', async ({ page }) => {
  const { before, centers } = await open(page, 'single', true); await hold(page);
  await page.mouse.move(centers[1][0], centers[1][1]); await page.mouse.down();
  await expect.poll(() => state(page)).toMatchObject({ captured: true });
  await page.mouse.move(centers[1][0] + 6, centers[1][1]);
  await page.mouse.move(centers[1][0] + 3, centers[1][1]); await page.mouse.up();
  await click(page, centers[2]); await retainedWhileHeld(page, before); expect(await release(page)).toBe(true);
  const after = await snapshot(page); exact(after, [2]); order(after); positionAndCamera(before, after);
  expect(after).toMatchObject({ captured: false, dragging: false, draft: false, active: false, error: null });
  const firstDown = after.pointers.findIndex(pointer => pointer.type === 'pointerdown');
  const firstUp = after.pointers.findIndex(pointer => pointer.type === 'pointerup');
  const path = after.pointers.slice(firstDown, firstUp + 1).filter(pointer => ['pointerdown', 'pointermove', 'pointerup'].includes(pointer.type));
  expect(path.map(pointer => pointer.x - path[0].x)).toEqual([0, 6, 3, 3]);
  expect(path.every(pointer => pointer.trusted && pointer.targetCanvas)).toBe(true);
  expect(after.pointers.slice(firstDown + 1, firstUp).filter(pointer => pointer.type === 'lostpointercapture')).toEqual([]);
  const cancelled = after.calls.filter(call => call.command.command === 'cancelSelection');
  expect(cancelled.length).toBeLessThanOrEqual(1);
  if (cancelled.length) {
    expect(cancelled[0]).toMatchObject({ completed: true, failed: false,
      result: { selected: 1, selectionDraft: false, contentRevision: after.summary.contentRevision } });
    // An initial query that began a native draft must restore its baseline
    // before either committed reentry/later pick.
    const afterCancel = after.calls.filter(call => call.sequence > cancelled[0].sequence);
    expect(afterCancel.filter(call => call.command.command === 'single').map(call => [call.command.index, call.command.operation]))
      .toEqual([[1, 0], [2, 0]]);
    const earlier = after.calls.filter(call => call.sequence < cancelled[0].sequence && call.command.command === 'single');
    expect(earlier.length).toBeLessThanOrEqual(1);
    expect(earlier.every(call => call.command.index === 1 && call.command.operation === 0)).toBe(true);
  } else {
    // A GPU query cancelled before a native draft has no preview to restore.
    // Both remaining Singles must be the exact committed reentry/FIFO picks.
    expect(after.calls.filter(call => call.command.command === 'single').map(call => [call.command.index, call.command.operation]))
      .toEqual([[1, 0], [2, 0]]);
  }
  expect(after.calls.filter(call => call.command.command === 'confirmSelection')).toHaveLength(2);
  const first = await undo(page); exact(first, [1]); expect(first.allBytes).toEqual(after.allBytes);
  const baseline = await undo(page); exact(baseline, [0]); expect(baseline.allBytes).toEqual(after.allBytes);
  exact(await redo(page), [1]); const redone = await redo(page); exact(redone, [2]); expect(redone.allBytes).toEqual(after.allBytes);
});

test('Polygon retains native mouse click counts and double-click finishes exactly four vertices in one selection entry', async ({ page }) => {
  const { before, centers } = await open(page, 'polygon', true); await hold(page);
  // This literal rectangle encloses centers 1 and 2, with both left-column
  // fixture centers outside. The fourth vertex's second mousedown finishes it.
  const vertices = [[centers[2][0] - 12, centers[2][1] - 12], [centers[1][0] + 12, centers[1][1] - 12],
    [centers[1][0] + 12, centers[1][1] + 12], [centers[2][0] - 12, centers[2][1] + 12]];
  for (const vertex of vertices.slice(0, 3)) await click(page, vertex);
  await page.mouse.dblclick(vertices[3][0], vertices[3][1]); await retainedWhileHeld(page, before);
  const waiting = await state(page), presses = waiting.mouseCompanions.filter(event => event.type === 'mousedown');
  expect(presses.map(event => event.detail)).toEqual([1, 1, 1, 1, 2]);
  expect(waiting.mouseCompanions.filter(event => event.type === 'dblclick').map(event => event.detail)).toEqual([2]);
  expect(waiting.mouseCompanions.every(event => event.trusted && event.targetCanvas)).toBe(true);
  expect(await release(page)).toBe(true); const after = await snapshot(page); exact(after, [1, 2]); order(after); positionAndCamera(before, after);
  const polygons = selection(after).filter(call => call.command.command === 'polygon'), finalVertices = presses.slice(0, 4).map(event => [event.x, event.y]);
  expect(polygons.length).toBeGreaterThan(0);
  expect(polygons.every(call => (call.command.points as number[][]).length <= 4)).toBe(true);
  expect(polygons.at(-1)!.command.points).toEqual(finalVertices);
  const beginnings = selection(after).filter(call => call.command.command === 'beginSelection');
  expect([1, 2]).toContain(beginnings.length);
  if (beginnings.length === 2) {
    // A final outline that overtakes its live preview runs finishFromBaseline:
    // restore the first draft, then begin the final four-vertex evaluation.
    const restored = after.calls.filter(call => call.command.command === 'cancelSelection' &&
      call.sequence > beginnings[0].sequence && call.sequence < beginnings[1].sequence);
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({ completed: true, failed: false,
      result: { selected: 1, selectionDraft: false, contentRevision: after.summary.contentRevision } });
    expect(after.calls.some(call => call.command.command === 'commitTransaction' && call.sequence > restored[0].sequence &&
      call.sequence < beginnings[1].sequence && call.completed && !call.failed && call.result?.selected === 1 &&
      call.result.selectionDraft === false && call.result.transaction === false)).toBe(true);
  }
  expect(selection(after).filter(call => call.command.command === 'confirmSelection')).toHaveLength(1);
  expect(after).toMatchObject({ captured: false, dragging: false, draft: false, active: false, error: null });
  const baseline = await undo(page); exact(baseline, [0]); expect(baseline.allBytes).toEqual(after.allBytes);
  const original = await undo(page); exact(original, [0]); expect(original.allBytes).toEqual(before.allBytes);
  exact(await redo(page), [0]); const redone = await redo(page); exact(redone, [1, 2]); expect(redone.allBytes).toEqual(after.allBytes);
});

for (const tool of ['color', 'fill'] as const)
  test(`${tool === 'color' ? 'Color' : 'Fill'} retains released clicks, captured tolerance and options, and FIFO native history through a manual grade`, async ({ page }) => {
    const { before, centers } = await open(page, tool);
    await page.evaluate(() => window.deferredGrade.toleranceDefaults({ colorTolerance: .01, fillTolerance: .5, connectedColor: false }));
    await hold(page); await click(page, centers[1]);
    await page.evaluate(() => {
      window.deferredGrade.defaults({ operation: 1, overlap: true, visibleOnly: true, live: true });
      window.deferredGrade.toleranceDefaults({ colorTolerance: .2, fillTolerance: .8, connectedColor: true });
    });
    await page.keyboard.down('Shift'); await click(page, centers[2]); await page.keyboard.up('Shift');
    await page.evaluate(() => {
      window.deferredGrade.defaults({ operation: 2, overlap: false, visibleOnly: false, live: false });
      window.deferredGrade.toleranceDefaults({ colorTolerance: 1, fillTolerance: 1, connectedColor: false });
    });
    await retainedWhileHeld(page, before); expect((await state(page)).releases).toEqual([]);
    expect(await release(page)).toBe(true); const after = await snapshot(page); exact(after, [1, 2]); order(after); positionAndCamera(before, after);
    expect(after.releases.map(release => [release.tool, release.operation])).toEqual([[tool, 0], [tool, 1]]);
    expect(after.releases.map(release => release.options)).toEqual([
      expect.objectContaining({ live: false, overlap: false, visibleOnly: false, colorTolerance: .01, fillTolerance: .5, connectedColor: false }),
      expect.objectContaining({ live: true, overlap: true, visibleOnly: true, colorTolerance: .2, fillTolerance: .8, connectedColor: true }),
    ]);
    const picks = selection(after).filter(call => call.command.command === (tool === 'color' ? 'colorPick' : 'fillPick'));
    expect(picks).toHaveLength(2); expect(picks.map(call => call.command.operation)).toEqual([0, 1]);
    for (let index = 0; index < 2; index++) {
      expect(picks[index].command.tolerance).toBeCloseTo((tool === 'color' ? [.01, .2] : [.5, .8])[index] ** 2, 12);
      expect(picks[index].command.camera).toEqual(before.camera);
      expect(picks[index].command.seed).toEqual([Math.floor(after.releases[index].x), Math.floor(after.releases[index].y)]);
    }
    if (tool === 'color') {
      // Ordinary Color uses source RGB; Connected uses the actual visible RGB
      // map. Both isolated literal fixture colors identify one source each.
      expect(picks.map(call => call.command.index)).toEqual([1, 2]);
      expect(picks.map(call => call.command.connected)).toEqual([false, true]);
      expect(after.summary.toleranceConnected).toBe(true);
    } else {
      // All four equal-opacity footprints are separated by transparent pixels.
      // The captured edge/visibility settings still reach each native Fill.
      expect(picks.map(call => [call.command.overlap, call.command.visibleOnly])).toEqual([[false, false], [true, true]]);
    }
    expect(after.summary.toleranceTool).toBe(tool); expect(after.summary.toleranceSessionId).not.toBeNull(); expect(after.error).toBeNull();
    const first = await undo(page); exact(first, [1]); expect(first.allBytes).toEqual(after.allBytes);
    const baseline = await undo(page); exact(baseline, [0]); expect(baseline.allBytes).toEqual(after.allBytes);
    const original = await undo(page); exact(original, [0]); expect(original.allBytes).toEqual(before.allBytes);
    exact(await redo(page), [0]); exact(await redo(page), [1]); const redone = await redo(page); exact(redone, [1, 2]);
    expect(redone.allBytes).toEqual(after.allBytes); expect(redone.error).toBeNull();
  });

for (const reason of ['blur', 'capture loss', 'resize', 'command'] as const)
  test(`${reason} drops released and held unapplied presses while the genuine grade is in flight`, async ({ page, context }) => {
    const { before, centers } = await open(page, 'single', true); await hold(page); await click(page, centers[1]);
    await page.mouse.move(centers[2][0], centers[2][1]); await page.mouse.down();
    await expect.poll(() => state(page)).toMatchObject({ captured: true });
    if (reason === 'blur') await blur(page, context);
    else if (reason === 'capture loss') {
      // setPointerCapture updates pending capture first. A further real move
      // dispatches gotpointercapture for this press before explicit release.
      await page.mouse.move(centers[2][0] + 1, centers[2][1]);
      await expect.poll(async () => {
        const value = await state(page), down = value.pointers.findLastIndex(pointer => pointer.type === 'pointerdown');
        return value.pointers.slice(down + 1).some(pointer => pointer.type === 'gotpointercapture' && pointer.trusted && pointer.targetCanvas);
      }).toBe(true);
      const lostBefore = (await state(page)).pointers.filter(pointer => pointer.type === 'lostpointercapture').length;
      await page.evaluate(() => window.deferredGrade.loseCapture());
      await page.mouse.move(centers[2][0] + 2, centers[2][1]);
      await expect.poll(async () => (await state(page)).pointers.filter(pointer => pointer.type === 'lostpointercapture').length).toBeGreaterThan(lostBefore);
    } else if (reason === 'resize') {
      await page.evaluate(() => window.deferredGrade.resize());
      await expect.poll(async () => (await state(page)).framebuffer[0]).not.toBe(before.framebuffer[0]);
    } else await page.evaluate(() => window.deferredGrade.startCommand());
    await page.mouse.up(); expect(selection(await state(page))).toEqual([]);
    expect(await page.evaluate(() => window.deferredGrade.release())).toBe(true);
    if (reason === 'command') expect(await page.evaluate(() => window.deferredGrade.joinCommand())).toBe(true);
    await page.evaluate(() => window.deferredGrade.settle()); const after = await snapshot(page);
    exact(after, reason === 'command' ? [0, 1, 2, 3] : [0]); expect(selection(after)).toEqual([]);
    expect(after).toMatchObject({ captured: false, dragging: false, draft: false, active: false, error: null });
    expect(after.allBytes).not.toEqual(before.allBytes);
    if (reason === 'command') { const selected = await undo(page); exact(selected, [0]); expect(selected.allBytes).toEqual(after.allBytes); }
    const original = await undo(page); exact(original, [0]); expect(original.allBytes).toEqual(before.allBytes);
  });

test('source replacement drops pending presses and no record can replay against the new native document', async ({ page }) => {
  const { before, centers } = await open(page, 'single', true); await hold(page); await click(page, centers[1]);
  await page.mouse.move(centers[2][0], centers[2][1]); await page.mouse.down();
  await page.evaluate(() => window.deferredGrade.startReplacement()); await page.mouse.up();
  await page.evaluate(() => window.deferredGrade.release()); await page.evaluate(() => window.deferredGrade.joinReplacement());
  await page.evaluate(() => window.deferredGrade.settle()); const after = await snapshot(page); exact(after, []);
  expect(after.sourceName).toBe('deferred-replacement.ply'); expect(after.sourceFingerprint).not.toEqual(before.sourceFingerprint);
  expect(after.revision.documentId).not.toBe(before.revision.documentId); expect(after.summary.canUndo).toBe(false); expect(after.summary.canRedo).toBe(false);
  expect(after.records[0][0]).toBeCloseTo(-.6, 6); expect(after.records[0][1]).toBeCloseTo(-.65, 6); expect(after.records[0][2]).toBe(0);
  expect(selection(after)).toEqual([]); expect(after).toMatchObject({ captured: false, dragging: false, draft: false, active: false, error: null });
});

test('a real native grade followed by refused GPU publication cancels pending presses and restores native bytes', async ({ page }) => {
  const { before, centers } = await open(page, 'single', true); await hold(page); await click(page, centers[1]);
  await page.mouse.move(centers[2][0], centers[2][1]); await page.mouse.down(); await page.mouse.up();
  await retainedWhileHeld(page, before); await page.evaluate(() => window.deferredGrade.failPublication());
  expect(await release(page)).toBe(false); const after = await snapshot(page); exact(after, [0]);
  expect(after.publicationFailed).toBe(true); expect(after.error).toContain('refused publication after actual GPU completion');
  expect(after.allBytes).toEqual(before.allBytes); expect(after.records).toEqual(before.records); positionAndCamera(before, after);
  expect(selection(after)).toEqual([]); expect(after.summary.canUndo).toBe(before.summary.canUndo); expect(after.summary.canRedo).toBe(before.summary.canRedo);
  expect(after).toMatchObject({ captured: false, dragging: false, draft: false, active: false });
});
