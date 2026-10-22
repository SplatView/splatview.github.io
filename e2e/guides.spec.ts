import { expect, test, type Page } from '@playwright/test';
import type {} from './guides-harness';

type View = ReturnType<Window['guidesHarness']['view']>;
type Layout = NonNullable<ReturnType<Window['guidesHarness']['presentation']>>;
type Snapshot = Awaited<ReturnType<Window['guidesHarness']['snapshot']>>;
const titles = ['Guides: none. Click for grid.', 'Guides: horizontal grid. Click for XYZ axes.',
  'Guides: XYZ axes. Click for both.', 'Guides: grid and axes. Click to hide.'];
const modes = ['none', 'grid', 'axes', 'both'];
const guides = (page: Page) => page.getByRole('button', { name: 'Viewport guides', exact: true });
const overlay = (page: Page) => page.locator('.viewport-guides');
const canvas = (page: Page) => page.getByLabel('SplatView scene', { exact: true });
async function ready(page: Page) {
  await page.waitForFunction(() => window.geometryViewerError || window.guidesHarness?.ready());
  expect(await page.evaluate(() => window.geometryViewerError)).toBeUndefined();
}
async function coherent(page: Page) {
  await expect.poll(() => page.evaluate(() => {
    const frame = window.guidesHarness.presentation(), camera = window.guidesHarness.view();
    return !!frame && frame.revision === camera.revision && frame.width === camera.width && frame.height === camera.height;
  })).toBe(true);
}
async function mode(page: Page, desired: string) {
  for (let count = 0; count < 4; count++) {
    const current = titles.indexOf((await guides(page).getAttribute('title'))!);
    expect(current).toBeGreaterThanOrEqual(0);if (modes[current] === desired) break;
    await guides(page).click();await expect(guides(page)).toHaveAttribute('title', titles[(current + 1) % 4]);
  }
  if (desired === 'none') await expect(overlay(page)).toHaveCount(0);
  else { await expect(overlay(page)).toHaveAttribute('data-guides-mode', desired);await coherent(page); }
}
async function pose(page: Page, distance = 6) {
  await page.evaluate(distance => {
    const view = window.guidesHarness.view();window.guidesHarness.setCamera([0, 0, 0, .7, .5, distance, 1, 60, 0, 0, view.width / view.height]);
  }, distance);
  await page.evaluate(() => window.guidesHarness.settle());
}
async function frame(page: Page) {
  await coherent(page);return page.evaluate(() => ({ view: window.guidesHarness.view(), layout: window.guidesHarness.presentation()! }));
}
// Independent double-precision homogeneous clipping. The expected path applies
// view then projection separately; it imports no production guides arithmetic.
function expectedLine(from: number[], to: number[], view: View) {
  const multiply = (matrix: number[], point: number[]) => Array.from({ length: 4 }, (_, row) =>
    matrix[row] * point[0] + matrix[row + 4] * point[1] + matrix[row + 8] * point[2] + matrix[row + 12] * point[3]);
  const clip = (point: number[]) => multiply(view.projection, multiply(view.view, [...point, 1]));
  const a = clip(from), b = clip(to), planes = ([x, y, z, w]: number[]) => [x + w, w - x, y + w, w - y, z, w - z];
  const da = planes(a), db = planes(b);let low = 0, high = 1;
  for (let index = 0; index < 6; index++) {
    if (da[index] < 0 && db[index] < 0) return null;
    if (da[index] < 0) low = Math.max(low, da[index] / (da[index] - db[index]));
    if (db[index] < 0) high = Math.min(high, da[index] / (da[index] - db[index]));
  }
  if (low > high) return null;
  const at = (t: number) => a.map((value, index) => value + (b[index] - value) * t);
  const screen = ([x, y, , w]: number[]) => [(x / w + 1) * view.width / 2, (1 - y / w) * view.height / 2];
  return [...screen(at(low)), ...screen(at(high))];
}
function projections(view: View, layout: Layout) {
  expect(layout.revision).toBe(view.revision);expect(layout.width).toBe(view.width);expect(layout.height).toBe(view.height);
  expect(layout.lines.length).toBeGreaterThan(0);
  for (const line of layout.lines) {
    const projected = expectedLine(line.from, line.to, view);expect(projected).not.toBeNull();
    [line.x1, line.y1, line.x2, line.y2].forEach((coordinate, index) => {
      expect(Number.isFinite(coordinate)).toBe(true);expect(Math.abs(coordinate - projected![index])).toBeLessThan(.08);
    });
  }
}
function sceneUnchanged(after: Snapshot, before: Snapshot) {
  for (const key of ['records', 'gpuRecords', 'masks', 'gpuMasks', 'grade', 'appliedGrade', 'sourceFingerprint', 'sourceName',
    'camera', 'tool', 'fly', 'autoOrbit', 'scale', 'opacity', 'preview', 'colorSession'] as const) expect(after[key], key).toEqual(before[key]);
  for (const key of ['revision', 'contentRevision', 'count', 'sourceCount', 'shDegree', 'selected', 'visible', 'canUndo', 'canRedo',
    'alignment', 'filter', 'transformSession', 'opacitySession'] as const) expect(after.summary[key], key).toEqual(before.summary[key]);
}
async function tools(page: Page) {
  if (!(await page.evaluate(() => window.opacityHarness.state())).toolsOpen) await page.getByRole('button', { name: 'Tools', exact: true }).click();
}
async function stageGrade(page: Page) {
  await tools(page);await page.getByRole('slider', { name: 'Brightness', exact: true }).press('Enter');
  await page.getByRole('textbox', { name: 'Brightness value', exact: true }).fill('1.25');
  await page.getByRole('textbox', { name: 'Brightness value', exact: true }).press('Enter');
}

test.beforeEach(async ({ page }) => {
  await page.goto('/e2e/guides-harness.html');await ready(page);await page.evaluate(() => window.guidesHarness.load());await pose(page);
});
test.afterEach(async ({ page }) => { await page.evaluate(() => window.guidesHarness?.stop()); });

test('the native36px Axes control cycles None, grid, axes and both beside Background and is disabled without a scene', async ({ page }) => {
  await page.reload();await ready(page);await expect(guides(page)).toBeDisabled();await expect(guides(page)).toHaveAttribute('title', titles[0]);
  await expect(overlay(page)).toHaveCount(0);await page.evaluate(() => window.guidesHarness.load());await pose(page);
  const group = page.getByRole('group', { name: 'Guides and background', exact: true });
  await expect(guides(page)).toHaveAttribute('type', 'button');
  expect(await group.getByRole('button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label')))).toEqual(['Viewport guides', 'Background']);
  const box = (await guides(page).boundingBox())!;expect(box.width).toBe(36);expect(box.height).toBe(36);
  await expect(guides(page).locator('svg')).toHaveCount(1);const glyph = await guides(page).locator('svg').innerHTML();
  for (let next = 1; next <= 4; next++) {
    await guides(page).click();await expect(guides(page)).toHaveAttribute('title', titles[next % 4]);
    await expect(guides(page)).toHaveAttribute('aria-pressed', String(next % 4 !== 0));
    expect(await guides(page).locator('svg').innerHTML()).toBe(glyph);
    if (next % 4) await expect(overlay(page)).toHaveAttribute('data-guides-mode', modes[next % 4]);
    else await expect(overlay(page)).toHaveCount(0);
  }
});

test('the horizontal grid uses world XZ cells,1-2-5 spacing, major fade and background contrast', async ({ page }, info) => {
  await mode(page, 'grid');const observations = [];
  for (const [distance, step] of [[3, .2], [40, 2], [80, 5], [140, 10]]) {
    await pose(page, distance);const current = await frame(page);expect(current.layout.step).toBeCloseTo(step, 8);projections(current.view, current.layout);
    expect(current.layout.lines.length).toBeLessThanOrEqual(82);
    for (const line of current.layout.lines) {
      expect(line.kind).toBe('grid');expect(line.from[1]).toBe(0);expect(line.to[1]).toBe(0);expect(line.width).toBe(1);
      const axis = line.from[0] === line.to[0] ? 0 : 2;expect(line.from[axis]).toBe(line.to[axis]);
      expect(line.from[axis] / step).toBeCloseTo(line.cell!, 4);expect(line.major).toBe(Math.abs(line.cell!) % 5 === 0);
      const alpha = Math.round((line.major ? .22 : .11) * (1 - .7 * Math.abs(line.cell!) / 20) * 255);
      expect(Math.abs(line.opacity * 255 - alpha)).toBeLessThanOrEqual(1);expect(line.stroke).toBe('rgb(230, 230, 230)');
    }
    observations.push(current);
  }
  await pose(page);const before = await page.evaluate(() => window.guidesHarness.view());
  for (const background of ['gray', 'white']) {
    await page.getByRole('button', { name: 'Background', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.guidesHarness.view().background)).toBe(background);
    await expect.poll(() => page.evaluate(() => window.guidesHarness.presentation()?.lines.every(line => line.stroke === 'rgb(26, 26, 26)'))).toBe(true);
    expect((await page.evaluate(() => window.guidesHarness.view())).state).toEqual(before.state);
  }
  await info.attach('guides-grid-world-quantization-clipping', { body: JSON.stringify(observations), contentType: 'application/json' });
});

test('six world-axis segments keep captured RGB, positive and negative alpha, labels and origin dimensions', async ({ page }, info) => {
  await mode(page, 'axes');const current = await frame(page);projections(current.view, current.layout);
  expect(current.layout.lines).toHaveLength(6);expect(current.layout.labels).toHaveLength(3);expect(current.layout.origin?.radius).toBe(2.5);
  const colors: Record<string, string> = { X: 'rgb(236, 100, 100)', Y: 'rgb(125, 210, 146)', Z: 'rgb(105, 165, 245)' };
  for (const line of current.layout.lines) {
    expect(line.kind).toBe('axis');expect(line.stroke).toBe(colors[line.axis!]);const axis = 'XYZ'.indexOf(line.axis!);
    expect(line.direction === 'positive' ? line.from : line.to).toEqual([0, 0, 0]);
    const endpoint = line.direction === 'positive' ? line.to : line.from;
    endpoint.forEach((value, index) => expect(value).toBeCloseTo(index === axis ? current.layout.step * (line.direction === 'positive' ? 5 : -20) : 0, 6));
    expect(line.width).toBe(line.direction === 'positive' ? 1.5 : 1);expect(Math.round(line.opacity * 255)).toBe(line.direction === 'positive' ? 204 : 61);
  }
  for (const label of current.layout.labels) { expect(label.text).toBe(label.axis);expect(label.color).toBe(colors[label.axis!]);expect(label.shadowX - label.x).toBe(1);expect(label.shadowY - label.y).toBe(1); }
  expect(current.layout.origin?.fill).toBe('rgb(230, 230, 230)');expect(current.layout.origin?.opacity).toBe(.8);
  await expect(overlay(page)).toHaveAttribute('aria-hidden', 'true');await expect(overlay(page)).toHaveCSS('pointer-events', 'none');
  await info.attach('guides-axis-independent-clip-projection', { body: JSON.stringify(current), contentType: 'application/json' });
});

test('orbit, right-drag pan and wheel navigation reproject the overlay from the actual native camera', async ({ page }) => {
  await mode(page, 'both');let previous = await frame(page);const box = (await canvas(page).boundingBox())!;
  for (const action of ['orbit', 'pan', 'wheel']) {
    await page.mouse.move(box.x + box.width * .5, box.y + box.height * .4);
    if (action === 'wheel') await page.mouse.wheel(0, 180);
    else { const button = action === 'pan' ? 'right' : 'left';await page.mouse.down({ button });await page.mouse.move(box.x + box.width * .5 + 55, box.y + box.height * .4 + 25, { steps: 5 });await page.mouse.up({ button }); }
    await expect.poll(() => page.evaluate(() => window.guidesHarness.view().revision)).toBeGreaterThan(previous.view.revision);
    const current = await frame(page);expect(current.view.state).not.toEqual(previous.view.state);projections(current.view, current.layout);previous = current;
  }
});

test('resizing uses CSS viewport projection and DPR2 retains native CSS widths and origin radius', async ({ page, browser, baseURL }) => {
  await mode(page, 'axes');await page.setViewportSize({ width: 990, height: 650 });const resized = await frame(page);projections(resized.view, resized.layout);
  expect(resized.view.width).toBe(990);expect(resized.view.height).toBe(650);
  const context = await browser.newContext({ baseURL, viewport: { width: 900, height: 600 }, deviceScaleFactor: 2, ignoreHTTPSErrors: true });
  await context.addInitScript(() => localStorage.setItem('splatview.tutorial.v1', '{"tutorial_prompt_handled":"handled"}'));
  try {
    const high = await context.newPage();await high.goto('/e2e/guides-harness.html');await ready(high);await high.evaluate(() => window.guidesHarness.load());await pose(high);await mode(high, 'axes');
    const current = await frame(high);expect(current.view.dpr).toBe(2);expect(current.view.backingWidth / current.view.width).toBeCloseTo(2, 2);
    projections(current.view, current.layout);expect(current.layout.origin?.radius).toBe(2.5);
    expect(current.layout.lines.map(line => line.width)).toEqual([1, 1.5, 1, 1.5, 1, 1.5]);
  } finally { await context.close(); }
});

test('Theme and Font size change chrome without changing fixed guide-axis ink or CSS dimensions', async ({ page }) => {
  await mode(page, 'axes');const before = (await frame(page)).layout;
  await tools(page);await page.getByRole('button', { name: 'Settings', exact: true }).click();const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.getByRole('button', { name: 'Theme', exact: true }).click();await page.getByRole('listbox', { name: 'Theme choices', exact: true }).getByRole('option', { name: 'Bright', exact: true }).click();
  await settings.getByRole('button', { name: 'Font size', exact: true }).click();await page.getByRole('listbox', { name: 'Font size choices', exact: true }).getByRole('option', { name: 'Large', exact: true }).click();
  await settings.getByRole('button', { name: 'Close Settings', exact: true }).click();const after = (await frame(page)).layout;
  const ink = (layout: Layout) => layout.lines.map(({ axis, direction, stroke, opacity, width }) => ({ axis, direction, stroke, opacity, width }));
  expect(ink(after)).toEqual(ink(before));expect(after.origin?.radius).toBe(before.origin?.radius);expect(after.labels.map(label => label.color)).toEqual(before.labels.map(label => label.color));
  expect((await guides(page).boundingBox())!.width).toBe(36);
});

test('raw renderer PNG bytes exclude guides while hiding only the SVG changes the displayed image', async ({ page }, info) => {
  const plain = await page.evaluate(() => window.guidesHarness.capture());await mode(page, 'both');await page.evaluate(() => window.guidesHarness.settle());
  const guided = await page.evaluate(() => window.guidesHarness.capture());expect(guided).toEqual(plain);
  const bounds = (await canvas(page).boundingBox())!, visible = await page.screenshot({ clip: bounds });
  await expect(overlay(page)).toHaveCSS('z-index', '1');
  const gestureOverlay = page.locator('.gesture-overlay');
  if (await gestureOverlay.count()) await expect(gestureOverlay.first()).toHaveCSS('z-index', '2');
  const hiddenStyle = await page.addStyleTag({ content: '.viewport-guides{visibility:hidden!important}' });
  const hidden = await page.screenshot({ clip: bounds });expect(visible.equals(hidden)).toBe(false);await hiddenStyle.evaluate(element => element.parentNode?.removeChild(element));
  await info.attach('guides-visible-svg.png', { body: visible, contentType: 'image/png' });await info.attach('guides-hidden-only-svg.png', { body: hidden, contentType: 'image/png' });
  await info.attach('guides-excluded-raw-renderer-png', { body: JSON.stringify({ plain, guided }), contentType: 'application/json' });
});

test('idle guide cycles schedule no native command, display GPU draw or continuous overlay frame', async ({ page }, info) => {
  await page.evaluate(() => window.guidesHarness.settle());await page.evaluate(() => window.guidesHarness.observe());
  const before = await page.evaluate(() => window.guidesHarness.counters());
  for (const next of ['grid', 'axes', 'both', 'none', 'grid', 'axes', 'both', 'none']) await mode(page, next);
  await page.evaluate(() => window.guidesHarness.waitFrames(12));const after = await page.evaluate(() => window.guidesHarness.counters());
  expect(after).toEqual(before);expect(after.commands).toEqual([]);
  await info.attach('guides-idle-real-display-and-command-counters', { body: JSON.stringify({ before, after }), contentType: 'application/json' });
});

test('guide cycles retain exact native/GPU data, staged grade, source, camera and executable Redo', async ({ page }, info) => {
  await page.evaluate(async () => { await window.opacityHarness.selectedFixture();await window.opacityHarness.command({ command: 'invert' });await window.opacityHarness.command({ command: 'undo' }); });
  await stageGrade(page);const before = await page.evaluate(() => window.guidesHarness.snapshot());expect(before.summary.canRedo).toBe(true);expect(before.grade[0]).toBe(1.25);
  for (const next of ['grid', 'axes', 'both', 'none']) await mode(page, next);
  const after = await page.evaluate(() => window.guidesHarness.snapshot());sceneUnchanged(after, before);
  await page.getByRole('button', { name: 'Reset color preview', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.opacityHarness.state().grade[0])).toBe(1);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect.poll(async () => (await page.evaluate(() => window.guidesHarness.snapshot())).masks).not.toEqual(before.masks);
  await info.attach('guides-native-gpu-grade-history-preserved', { body: JSON.stringify({ before, after }), contentType: 'application/json' });
});

// Fade / boost opacity previews are excluded from web-lite (color.advanced).

test('point-cloud and mesh viewers retain navigation and raw captures with both reference guides', async ({ page }) => {
  for (const source of ['points', 'mesh'] as const) {
    await page.evaluate(source => window.guidesHarness.loadGeometry(source), source);await pose(page);await mode(page, 'none');
    const before = await page.evaluate(() => window.guidesHarness.capture());await mode(page, 'both');const current = await frame(page);projections(current.view, current.layout);
    expect((await page.evaluate(() => window.opacityHarness.state())).summary?.kind).toBe(source === 'points' ? 1 : 2);
    expect(await page.evaluate(() => window.guidesHarness.capture())).toEqual(before);await expect(guides(page)).toBeEnabled();
  }
});

test('clear, source loading and camera Reset retain UI-instance mode while a full page reload defaults to None', async ({ page }) => {
  await mode(page, 'both');await page.getByRole('button', { name: 'Reset camera', exact: true }).click();await expect(overlay(page)).toHaveAttribute('data-guides-mode', 'both');
  await page.evaluate(() => window.guidesHarness.close());await expect(guides(page)).toBeDisabled();await expect(overlay(page)).toHaveCount(0);
  await expect(guides(page)).toHaveAttribute('title', titles[3]);await page.evaluate(() => window.guidesHarness.load('guides-reloaded.ply'));await pose(page);
  await expect(overlay(page)).toHaveAttribute('data-guides-mode', 'both');await coherent(page);
  await page.reload();await ready(page);await expect(guides(page)).toHaveAttribute('title', titles[0]);await expect(overlay(page)).toHaveCount(0);await expect(guides(page)).toBeDisabled();
});

test('saved-view camera records and Reset stay independent of the local guides choice', async ({ page }) => {
  await mode(page, 'axes');const first = await page.evaluate(() => window.guidesHarness.saveView());
  await mode(page, 'none');const second = await page.evaluate(() => window.guidesHarness.saveView());expect(second).toEqual(first);
  expect(Object.keys(second)).not.toContain('guides');expect(Object.keys(second)).not.toContain('viewportGuides');
  await mode(page, 'both');await page.evaluate(() => {const view = window.guidesHarness.view();view.state[3] += .2;window.guidesHarness.setCamera(view.state);window.guidesHarness.resetCamera();});
  await expect(overlay(page)).toHaveAttribute('data-guides-mode', 'both');const current = await frame(page);projections(current.view, current.layout);
});

test('real GPU recovery retains guide mode and refreshes a coherent view without changing scene history', async ({ page }, info) => {
  await mode(page, 'both');const before = await page.evaluate(() => window.guidesHarness.snapshot());const recovered = await page.evaluate(() => window.guidesHarness.recover());
  expect(recovered.accepted).toBe(true);expect(recovered.sameClient).toBe(true);expect(recovered.replacedRenderer).toBe(true);expect(recovered.oldRetired).toBe(true);
  sceneUnchanged(recovered.after, before);await expect(overlay(page)).toHaveAttribute('data-guides-mode', 'both');const current = await frame(page);projections(current.view, current.layout);
  expect(recovered.after.deviceEpoch).not.toBe(before.deviceEpoch);
  await info.attach('guides-real-device-recovery', { body: JSON.stringify({ before, recovered, current }), contentType: 'application/json' });
});
