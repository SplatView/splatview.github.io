import { expect, test, type Page } from '@playwright/test';
import type { NativeSummary, SceneCommand } from '../../src/document/types';

type PivotObservation = { commands: SceneCommand[]; summary?: NativeSummary;
  focus: { command: SceneCommand; summary: NativeSummary; ownsPoint: boolean; editOwner: boolean }[] };
declare global { interface Window { pivotObservation: PivotObservation } }
function asymmetricPly() {
  const fields = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
  return Buffer.from(['ply', 'format ascii 1.0', 'element vertex 2', ...fields.map(name => `property float ${name}`), 'end_header',
    [0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 1, 0, 0, 0].join(' '),
    [6, 2, 0, 0, 0, 0, 2, Math.log(3), Math.log(3), Math.log(3), 1, 0, 0, 0].join(' '), ''].join('\n'));
}
async function open(page: Page, keepAutomatic = false) {
  await page.addInitScript(() => {
    localStorage.setItem('splatview.tools-mode.v1', 'pro');
    const NativeWorker = window.Worker;
    const observation: PivotObservation = { commands: [], focus: [] }; window.pivotObservation = observation;
    window.Worker = class extends NativeWorker {
      private requests = new Map<number, SceneCommand>();
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.addEventListener('message', event => {
          const value = event.data, command = this.requests.get(value?.requestId);
          if (value?.summary) observation.summary = structuredClone(value.summary);
          if (value?.type === 'result' && command?.command === 'transformFocus') observation.focus.push({
            command: structuredClone(command), summary: structuredClone(value.summary),
            ownsPoint: Object.hasOwn(value.summary, 'point'), editOwner: value.operationOwner !== undefined });
        });
      }
      override postMessage(value: unknown, options?: Transferable[] | StructuredSerializeOptions) {
        const data = value as { requestId?: number; command?: SceneCommand };
        if (data.command) { observation.commands.push(structuredClone(data.command)); if (data.requestId !== undefined) this.requests.set(data.requestId, structuredClone(data.command)); }
        if (Array.isArray(options)) super.postMessage(value, options); else super.postMessage(value, options);
      }
    };
  });
  await page.goto('/'); await expect(page.getByRole('button', { name: 'Open scene', exact: true })).toBeEnabled();
  await page.getByLabel('Open scene files').setInputFiles({ name: 'asymmetric-pivot.ply', mimeType: 'application/octet-stream', buffer: asymmetricPly() });
  const tools = page.getByRole('complementary', { name: 'Tools', exact: true });
  if (!await tools.isVisible()) await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await tools.getByRole('button', { name: 'Select all', exact: true }).click();
  await expect(tools.locator('.model-stats')).toHaveText('2/2 splats | SH0');
  const pivot = tools.getByRole('button', { name: 'Cycle pivot', exact: true });
  await expect(pivot).toHaveAttribute('title', 'Pivot: selection center\nClick for origin (0,0,0)');
  await expect(pivot).toBeEnabled();
  if (!keepAutomatic) {
    await pivot.click(); await pivot.click();
    await expect(pivot).toHaveAttribute('title', 'Pivot: scene center\nClick for selection center');
    await page.evaluate(() => { window.pivotObservation.focus = []; window.pivotObservation.commands = []; });
  }
  return { tools, pivot,
    field: (name: string) => tools.getByRole('spinbutton', { name, exact: true }) };
}

test('shipped pivot cycle uses full selected bounds and changes no geometry, history or edit owner', async ({ page }, info) => {
  const f = await open(page), before = await page.evaluate(() => window.pivotObservation.summary!);
  const commandStart = await page.evaluate(() => window.pivotObservation.commands.length);
  await expect(f.pivot).toHaveAttribute('aria-pressed', 'true');
  await f.pivot.click(); await expect(f.pivot).toHaveAttribute('title', 'Pivot: selection center\nClick for origin (0,0,0)');
  // Desktop PLY import converts file Y/Z to the viewer's internal convention.
  await expect(f.field('Pivot X')).toHaveValue('6.00'); await expect(f.field('Pivot Y')).toHaveValue('-2.00');
  await expect(f.pivot).toHaveAttribute('aria-pressed', 'true');
  await expect(f.tools.getByRole('button', { name: 'Apply transform', exact: true })).toBeHidden();
  await f.pivot.click(); await expect(f.field('Pivot X')).toHaveValue('0.00');
  await expect(f.pivot).toHaveAttribute('title', 'Pivot: origin (0,0,0)\nClick for scene center');
  await f.pivot.click(); await expect(f.pivot).toHaveAttribute('title', 'Pivot: scene center\nClick for selection center');
  await expect(f.field('Pivot X')).toHaveValue(before.center[0].toFixed(2));
  const observed = await page.evaluate(start => ({ focus: window.pivotObservation.focus,
    commands: window.pivotObservation.commands.slice(start), after: window.pivotObservation.summary! }), commandStart);
  expect(observed.focus).toHaveLength(2);
  expect(observed.focus.map(value => value.command.scope)).toEqual(['selection', 'scene']);
  for (const result of observed.focus) {
    expect(result.ownsPoint).toBe(true); expect(result.editOwner).toBe(false);
    expect(result.summary).toMatchObject({ revision: before.revision, contentRevision: before.contentRevision,
      canUndo: before.canUndo, canRedo: before.canRedo, selected: 2, transformSession: null, transaction: false });
  }
  expect(observed.focus[0].summary.point![0]).toBeCloseTo(6, 5);
  expect(observed.commands.map(value => value.command)).toEqual(['transformFocus', 'transformFocus']);
  await info.attach('pivot-canonical-bounds-and-cycle', { body: JSON.stringify({ before, observed }), contentType: 'application/json' });
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('shipped retained transform pivots preserve staged translation and original base coordinates', async ({ page }, info) => {
  const f = await open(page);
  await f.field('Translation X').fill('4'); await f.field('Translation X').blur();
  await f.tools.getByRole('button', { name: 'Apply transform', exact: true }).click();
  await expect(f.tools.getByRole('button', { name: 'Apply transform', exact: true })).toBeHidden();
  const applied = await page.evaluate(() => window.pivotObservation.summary!);
  await f.field('Translation Y').fill('7'); await f.field('Translation Y').blur();
  await f.pivot.click(); await expect(f.field('Pivot X')).toHaveValue('6.00');
  await expect(f.field('Translation X')).toHaveValue('4.00'); await expect(f.field('Translation Y')).toHaveValue('7.00');
  const observed = await page.evaluate(() => window.pivotObservation);
  expect(observed.focus.map(value => value.command.scope)).toEqual(['scene', 'selection']);
  const selected = observed.focus.filter(value => value.command.scope === 'selection');
  expect(selected).toHaveLength(1);
  expect(selected[0].command.transformBase).toEqual({ id: applied.transformSession!.id,
    baseId: applied.transformSession!.baseId, epoch: applied.transformSession!.epoch });
  expect(selected[0].summary.contentRevision).toBe(applied.contentRevision);
  for (const value of observed.focus) { expect(value.editOwner).toBe(false); expect(value.ownsPoint).toBe(true); }
  expect(observed.commands.filter(value => value.command === 'applyTransform')).toHaveLength(1);
  await f.tools.getByRole('button', { name: 'Cancel transform preview', exact: true }).click();
  await expect(f.field('Translation Y')).toHaveValue('0.00'); await expect(f.field('Pivot X')).toHaveValue('6.00');
  await expect(f.tools.getByRole('button', { name: 'Apply transform', exact: true })).toBeHidden();
  await f.field('Pivot X').fill('11'); await f.field('Pivot X').blur();
  await expect(f.pivot).toHaveAttribute('title', 'Pivot: custom\nClick for scene center');
  await f.pivot.click(); await expect(f.field('Pivot X')).toHaveValue('3.00');
  await expect(f.field('Translation X')).toHaveValue('4.00');
  await info.attach('pivot-retained-transform-base', { body: JSON.stringify({ applied, observed }), contentType: 'application/json' });
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('shipped selection commits update pivots across clear, Undo and Redo without adding history', async ({ page }, info) => {
  const f = await open(page, true), initial = await page.evaluate(() => window.pivotObservation);
  expect(initial.summary!.selectionCommitRevision).toBeGreaterThan(0);
  expect(initial.focus).toHaveLength(1);
  await expect(f.field('Pivot X')).toHaveValue('6.00');
  await f.tools.getByRole('button', { name: 'Clear selection', exact: true }).click();
  await expect(f.pivot).toHaveAttribute('title', 'Pivot: origin (0,0,0)\nClick for scene center');
  await expect(f.field('Pivot X')).toHaveValue('0.00');
  const cleared = await page.evaluate(() => window.pivotObservation.summary!);
  expect(cleared.selectionCommitRevision).toBeGreaterThan(initial.summary!.selectionCommitRevision!);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(f.pivot).toHaveAttribute('title', 'Pivot: selection center\nClick for origin (0,0,0)');
  await expect(f.field('Pivot X')).toHaveValue('6.00');
  await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(f.field('Pivot X')).toHaveValue('0.00');
  const observed = await page.evaluate(() => window.pivotObservation);
  expect(observed.summary!.contentRevision).toBe(initial.summary!.contentRevision);
  expect(observed.commands.filter(value => value.command === 'beginTransform')).toHaveLength(0);
  expect(observed.focus).toHaveLength(2);
  for (const value of observed.focus) expect(value.editOwner).toBe(false);
  await info.attach('automatic-pivot-history', { body: JSON.stringify({ initial, cleared, observed }), contentType: 'application/json' });
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('shipped Custom reference maps once when a recipe ends and survives geometry Undo', async ({ page }, info) => {
  const f = await open(page, true), before = await page.evaluate(() => window.pivotObservation.summary!);
  await f.field('Pivot X').fill('11'); await f.field('Pivot X').blur();
  await f.field('Translation X').fill('4'); await f.field('Translation X').blur();
  await f.tools.getByRole('button', { name: 'Apply transform', exact: true }).click();
  await expect(f.tools.getByRole('button', { name: 'Apply transform', exact: true })).toBeHidden();
  await expect(f.field('Pivot X')).toHaveValue('11.00');
  // The already complete selection is unchanged. This boundary materializes
  // the transform and carries the Custom base-space point into world space.
  await f.tools.getByRole('button', { name: 'Select all', exact: true }).click();
  await expect(f.field('Pivot X')).toHaveValue('15.00');
  await expect(f.pivot).toHaveAttribute('title', 'Pivot: custom\nClick for scene center');
  const materialized = await page.evaluate(() => window.pivotObservation.summary!);
  expect(materialized.transformSession).toBeNull();
  expect(materialized.selectionCommitRevision).toBe(before.selectionCommitRevision);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(async () => page.evaluate(expected => {
    const value = window.pivotObservation.summary;
    return !!value && value.transaction === false && value.pending === false && value.canRedo &&
      value.revision > expected.revision && value.contentRevision === expected.contentRevision && value.center[0] === expected.center;
  }, { revision: materialized.revision, contentRevision: before.contentRevision, center: before.center[0] })).toBe(true);
  await expect(f.field('Pivot X')).toHaveValue('15.00');
  await expect(f.pivot).toHaveAttribute('title', 'Pivot: custom\nClick for scene center');
  const observed = await page.evaluate(() => window.pivotObservation);
  expect(observed.summary!.selectionCommitRevision).toBe(before.selectionCommitRevision);
  expect(observed.summary!.center[0]).toBeCloseTo(before.center[0], 5);
  await info.attach('automatic-pivot-custom-geometry', { body: JSON.stringify({ before, materialized, observed }), contentType: 'application/json' });
  await expect(page.getByRole('alert')).toHaveCount(0);
});
