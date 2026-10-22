import { expect, test, type Page } from '@playwright/test';
import { queuePly, queuePositions } from '../../e2e/queue-fixture';
import { chooseSelectionTool } from '../../e2e/selectTool';
import type { NativeSummary, SceneCommand } from '../../src/document/types';

type Observation = { commands: SceneCommand[]; summary?: NativeSummary };
declare global { interface Window { rangeObservation: Observation } }

async function open(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('splatview.tools-mode.v1', 'pro');
    const observation: Observation = { commands: [] }; window.rangeObservation = observation;
    const Original = window.Worker;
    window.Worker = class extends Original {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.addEventListener('message', event => { if (event.data?.summary) observation.summary = structuredClone(event.data.summary); });
      }
      override postMessage(value: unknown, options?: Transferable[] | StructuredSerializeOptions) {
        const command = (value as { command?: SceneCommand }).command;
        if (command) observation.commands.push(structuredClone(command));
        if (Array.isArray(options)) super.postMessage(value, options); else super.postMessage(value, options);
      }
    };
  });
  await page.goto('/'); await expect(page.getByRole('button', { name: 'Open scene', exact: true })).toBeEnabled();
  await page.getByLabel('Open scene files').setInputFiles({ name: 'range.ply', mimeType: 'application/octet-stream', buffer: Buffer.from(queuePly()) });
  const tools = page.getByRole('complementary', { name: 'Tools', exact: true });
  if (!await tools.isVisible()) await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await chooseSelectionTool(page, 'Color picker');
  await expect(tools.getByRole('button', { name: 'Range', exact: true })).toBeEnabled();
  await tools.getByRole('button', { name: 'Replace', exact: true }).click();
  // Compute reference projections in a separate shipping camera module; the
  // production app/controller remains untouched and no dev source is imported.
  const points = await page.evaluate(async positions => {
    const url = '/wasm/splatview-camera.mjs';
    const { default: factory } = await import(/* @vite-ignore */ url);
    const module = await factory(), pointer = module._malloc(46 * 4);
    try {
      const box = document.querySelector('canvas')!.getBoundingClientRect();
      const camera = [...window.rangeObservation.summary!.camera]; camera[10] = box.width / box.height;
      module.HEAPF32.set(camera, pointer / 4); module._sv_camera(pointer, 0, 0, 0, 0);
      const view = Array.from(module.HEAPF32.subarray(pointer / 4 + 11, pointer / 4 + 27)) as number[];
      const projection = Array.from(module.HEAPF32.subarray(pointer / 4 + 27, pointer / 4 + 43)) as number[];
      const mul = (point: number[], matrix: number[]) => Array.from({ length: 4 }, (_, c) => point.reduce((sum, value, r) => sum + value * matrix[r * 4 + c], 0));
      return positions.map(([x, y, z]) => {
        const clip = mul(mul([x, -y, -z, 1], view), projection);
        return [box.x + (clip[0] / clip[3] + 1) * box.width / 2, box.y + (1 - clip[1] / clip[3]) * box.height / 2];
      });
    } finally { module._free(pointer); }
  }, queuePositions);
  return { tools, points, range: tools.getByRole('button', { name: 'Range', exact: true }),
    radius: tools.getByRole('slider', { name: 'Radius', exact: true }),
    undo: tools.getByRole('button', { name: 'Undo', exact: true }), redo: tools.getByRole('button', { name: 'Redo', exact: true }) };
}
async function exactRadius(page: Page, value: number) {
  await page.getByRole('slider', { name: 'Radius', exact: true }).click({ button: 'right' });
  const field = page.getByRole('spinbutton', { name: 'Radius value', exact: true });
  await field.fill(String(value)); await field.press('Enter');
  await expect(field).toHaveCount(0);
}
async function tolerance(page: Page, value: number) {
  await page.getByRole('slider', { name: 'Selection tolerance', exact: true }).click({ button: 'right' });
  const field = page.getByRole('spinbutton', { name: 'Tolerance percent', exact: true });
  await field.fill(String(value)); await field.press('Enter');
}
async function selected(page: Page, count: number) {
  await expect(page.getByRole('complementary', { name: 'Tools', exact: true }).locator('.model-stats')).toHaveText(`${count}/5 splats | SH0`);
  await expect(page.locator('.status.panel')).toHaveCount(0);
}
const observed = (page: Page) => page.evaluate(() => ({ commands: window.rangeObservation.commands,
  summary: window.rangeObservation.summary && { selected: window.rangeObservation.summary.selected,
    revision: window.rangeObservation.summary.revision, contentRevision: window.rangeObservation.summary.contentRevision,
    toleranceSessionId: window.rangeObservation.summary.toleranceSessionId, toleranceRange: window.rangeObservation.summary.toleranceRange } }));

test('shipped Color Range amends the frozen pick in one Undo and preserves a tools-only sphere', async ({ page }, info) => {
  const f = await open(page); await tolerance(page, 100);
  await page.mouse.click(...f.points[0] as [number, number]); await selected(page, 5);
  const before = await observed(page);
  await f.range.click(); await exactRadius(page, .05); await selected(page, 1);
  const small = await observed(page);
  expect(small.summary!.toleranceSessionId).toBe(before.summary!.toleranceSessionId);
  expect(small.summary!.toleranceRange!.center![0]).toBeCloseTo(-.6, 6);
  await exactRadius(page, .4); await selected(page, 3);
  expect((await observed(page)).summary!.toleranceRange!.center).toEqual(small.summary!.toleranceRange!.center);
  await f.range.hover();
  const overlay = page.locator('.selection-range-overlay');
  await expect(overlay).toBeVisible(); await expect(overlay).toHaveAttribute('data-source-segments', '192');
  await page.mouse.move(...f.points[0] as [number, number]); await expect(overlay).toBeHidden();
  await f.undo.click(); await selected(page, 0); await expect(f.undo).toBeDisabled();
  await f.redo.click(); await selected(page, 3);
  await info.attach('range-frozen-center-history', { body: JSON.stringify({ before, small, after: await observed(page) }), contentType: 'application/json' });
  await expect(page.getByRole('alert')).toHaveCount(0);
});

for (const operation of ['Add', 'Subtract'] as const) test(`shipped Range ${operation} preserves selected centers outside its sphere`, async ({ page }, info) => {
  const f = await open(page); await tolerance(page, 100);
  if (operation === 'Add') {
    await chooseSelectionTool(page, 'Single splat');
    await page.mouse.click(...f.points[3] as [number, number]); await selected(page, 1);
    await chooseSelectionTool(page, 'Color picker');
  } else { await f.tools.getByRole('button', { name: 'Select all', exact: true }).click(); await selected(page, 5); }
  await f.tools.getByRole('button', { name: operation, exact: true }).click();
  await f.range.click(); await exactRadius(page, .05);
  await page.mouse.click(...f.points[0] as [number, number]); await selected(page, operation === 'Add' ? 2 : 4);
  await exactRadius(page, .4); await selected(page, operation === 'Add' ? 4 : 2);
  const after = await observed(page);
  await f.undo.click(); await selected(page, operation === 'Add' ? 1 : 5);
  await f.redo.click(); await selected(page, operation === 'Add' ? 4 : 2);
  await info.attach('range-combine-baseline', { body: JSON.stringify({ operation, after }), contentType: 'application/json' });
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('shipped Fill freezes its depth center, keeps independent Radius, and joins one settled slider amendment', async ({ page }, info) => {
  const f = await open(page); await f.range.click(); await exactRadius(page, .4);
  await chooseSelectionTool(page, 'Fill');
  await expect(f.range).toHaveAttribute('aria-pressed', 'false');
  await tolerance(page, 100); await page.mouse.click(...f.points[0] as [number, number]); await selected(page, 3);
  const before = await observed(page), center = before.summary!.toleranceRange!.center;
  expect(center).toHaveLength(3); expect(center!.every(Number.isFinite)).toBe(true);
  const pick = before.commands.filter(c => c.command === 'fillPick').at(-1)!;
  expect(pick.sampleRadiusPixels).toBeGreaterThan(0);
  await f.range.click(); await exactRadius(page, .4);
  await expect.poll(async () => (await observed(page)).summary!.toleranceRange!.radius).toBe(Math.fround(.4));
  const prior = (await observed(page)).commands.filter(c => c.command === 'fillTolerance').length;
  const box = (await f.radius.boundingBox())!;
  await page.mouse.move(box.x + box.width * .5, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width * .9, box.y + box.height / 2, { steps: 8 });
  expect((await observed(page)).commands.filter(c => c.command === 'fillTolerance')).toHaveLength(prior);
  await page.mouse.up();
  await expect.poll(async () => (await observed(page)).commands.filter(c => c.command === 'fillTolerance').length).toBe(prior + 1);
  await expect(page.locator('.status.panel')).toHaveCount(0);
  const after = await observed(page);
  expect(after.summary!.toleranceSessionId).toBe(before.summary!.toleranceSessionId);
  expect(after.summary!.toleranceRange!.center).toEqual(center);
  await chooseSelectionTool(page, 'Color picker');
  await expect(f.range).toHaveAttribute('aria-pressed', 'true');
  expect(Number(await f.radius.getAttribute('aria-valuenow'))).toBeCloseTo(.4, 6);
  await info.attach('range-fill-center-settled-input', { body: JSON.stringify({ before, after }), contentType: 'application/json' });
  await expect(page.getByRole('alert')).toHaveCount(0);
});
