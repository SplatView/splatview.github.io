import { expect, test, type Page } from '@playwright/test';
import type {} from './operation-harness';
import type { SceneCommand } from '../src/document/types';

type Snapshot = Awaited<ReturnType<Window['operationHarness']['snapshot']>>;
type State = ReturnType<Window['operationHarness']['state']>;
type Trace = ReturnType<Window['operationHarness']['trace']>;
type Node = { masks: number[]; content: number };
// The fixture creates these five history entries, then undoes its last Add.
// Keep the expected graph literal: restored summaries are not its oracle.
const graph: Node[] = [
  { masks: [0, 0, 0, 0, 0], content: 0 },
  { masks: [0, 0, 0, 0, 1], content: 0 },
  { masks: [0, 0, 0, 0, 2], content: 1 },
  { masks: [1, 0, 0, 0, 2], content: 1 },
  { masks: [1, 0, 1, 0, 2], content: 1 },
  { masks: [1, 1, 1, 0, 2], content: 1 },
];
const positions = [[-.75, -.2, -.1], [-.4, .2, -.05], [0, -.3, .1], [.4, .3, -.15], [.75, -.1, .15]];
const state = (page: Page) => page.evaluate(() => window.operationHarness.state());
const snapshot = (page: Page) => page.evaluate(() => window.operationHarness.snapshot());
const trace = (page: Page) => page.evaluate(() => window.operationHarness.trace());

async function settled(page: Page) {
  await expect.poll(async () => {
    const value = await state(page);
    return { busy: value.busy, recovery: value.recovery, renderer: value.rendererState,
      authoritative: typeof value.authoritativeWorker === 'number' };
  }).toEqual({ busy: false, recovery: 'idle', renderer: 'ready', authoritative: true });
}
async function command(page: Page, value: SceneCommand) {
  await page.evaluate(value => window.operationHarness.command(value), value);
  await settled(page); return snapshot(page);
}
function oracle(value: Snapshot, before: Snapshot, node: Node) {
  const selected = node.masks.filter(mask => (mask & 1) && !(mask & 2)).length;
  const visible = node.masks.filter(mask => !(mask & 2)).length;
  expect(value.summary).toMatchObject({ ok: true, loaded: true, kind: 0, count: 5, sourceCount: 5, shDegree: 3,
    selected, visible, contentRevision: node.content, pending: false, transaction: false, selectionDraft: false });
  expect(value.masks).toEqual(node.masks); expect(value.gpu.masks).toEqual(node.masks);
  expect(value.packed).toEqual(before.packed); expect(value.gpu.data).toEqual(before.packed);
  expect(value.resources.work).toBe(0);
  expect(value.sourceFingerprint).toEqual(before.sourceFingerprint); expect(value.sourceName).toBe(before.sourceName);
  expect(value.document.documentId).toBe(before.document.documentId);
  expect(value.document.sourceGeneration).toBe(before.document.sourceGeneration);
  expect(value.document.draftRevision).toBe(0); expect(value.camera).toEqual(before.camera);
  expect(value.checkpoint!.binding.source).toEqual(before.checkpoint!.binding.source);
  expect(value.checkpoint!.binding.subset).toEqual(before.checkpoint!.binding.subset);
  expect(value.checkpoint!.binding.core).toEqual(before.checkpoint!.binding.core);
  const packed = new DataView(Uint8Array.from(value.packed).buffer);
  positions.forEach((point, id) => expect([0, 4, 8].map(axis => packed.getFloat32(id * value.stride + axis, true)))
    .toEqual(point.map(Math.fround)));
  const original = before.sourceOutput, x = original.properties.indexOf('x');
  expect(x).toBeGreaterThanOrEqual(0);
  expect(original.properties.filter(name => /^f_rest_\d+$/.test(name))).toHaveLength(45);
  value.outputs.forEach((output, scope) => {
    const ids = node.masks.flatMap((mask, id) => !(mask & 2) &&
      (scope === 0 || scope === 1 && (mask & 1) || scope === 2 && !(mask & 1)) ? [id] : []);
    if (!ids.length) { expect(output).toBeNull(); return; }
    expect(output).not.toBeNull(); expect(output!.properties).toEqual(original.properties);
    expect(output!.records).toEqual(ids.map(id => {
      const record = original.records.find(record => record[x] === Math.fround(positions[id][0]));
      expect(record).toBeDefined(); return record;
    }));
  });
}
function replacement(value: Snapshot, before: Snapshot, evidence: Trace, target: string) {
  expect(value.authoritativeWorker).not.toBe(before.authoritativeWorker);
  expect(value.clientGeneration).not.toBe(before.clientGeneration); expect(value.scene).not.toBe(before.scene);
  expect(value.resources.scenes.find(scene => scene.id === before.scene)).toMatchObject({ retired: true, disposeCalls: 1 });
  expect(evidence.workers.find(worker => worker.id === before.authoritativeWorker)).toMatchObject({ injectedFailures: 1 });
  expect(evidence.workers.find(worker => worker.id === before.authoritativeWorker)!.terminated).toBeGreaterThanOrEqual(1);
  expect(evidence.workers.filter(worker => worker.injectedFailures > 0)).toHaveLength(1);
  const restores = evidence.requests.filter(request => request.type === 'recovery-restore' && request.forwarded);
  expect(restores).toHaveLength(1); expect(restores[0].worker).toBe(value.authoritativeWorker);
  expect(restores[0].data.binding).toMatchObject({ source: before.sourceFingerprint, subset: before.checkpoint!.binding.subset,
    core: before.checkpoint!.binding.core, revision: { documentId: before.document.documentId, sourceGeneration: before.document.sourceGeneration } });
  expect(evidence.responses.filter(response => response.type === 'recovery-result' && response.data.action === 'restore' && response.delivered)).toHaveLength(1);
  expect(evidence.requests.filter(request => request.type === 'source-load' || request.type === 'source-group-load')).toHaveLength(0);
  expect(evidence.requests.filter(request => request.worker === value.authoritativeWorker && request.type === 'command' && request.command === target)).toHaveLength(0);
  expect(evidence.requests.filter(request => request.type === 'operation' && request.action === 'rollback')).toHaveLength(0);
}
async function wholeHistory(page: Page, before: Snapshot, nodes: Node[], cursor: number) {
  let previous = await snapshot(page);
  const step = async (direction: 'undo' | 'redo', index: number) => {
    const next = await command(page, { command: direction }); oracle(next, before, nodes[index]);
    expect(next.summary.revision).toBe(previous.summary.revision + 1);
    expect(next.document.selectionRevision).toBe(previous.document.selectionRevision + 1);
    expect(next.document.contentRevision).toBe(previous.document.contentRevision +
      Number(nodes[index].content !== previous.summary.contentRevision));
    expect(next.summary.canUndo).toBe(index > 0); expect(next.summary.canRedo).toBe(index < nodes.length - 1);
    previous = next;
  };
  for (let index = cursor - 1; index >= 0; index--) await step('undo', index);
  expect(previous.summary.canUndo).toBe(false);
  for (let index = 1; index < nodes.length; index++) await step('redo', index);
  expect(previous.summary.canRedo).toBe(false);
  return previous;
}
type Scenario = { name: string; command: SceneCommand; prepareUndo: number; nodes: Node[]; cursor: number; changed: boolean };
const scenarios: Scenario[] = [
  { name: 'no-op Add', command: { command: 'single', index: 0, operation: 1 }, prepareUndo: 0, nodes: graph, cursor: 4, changed: false },
  { name: 'selection-only Add', command: { command: 'single', index: 3, operation: 1 }, prepareUndo: 0,
    nodes: [...graph.slice(0, 5), { masks: [1, 0, 1, 1, 2], content: 1 }], cursor: 5, changed: true },
  { name: 'selection Undo', command: { command: 'undo' }, prepareUndo: 0, nodes: graph, cursor: 3, changed: true },
  { name: 'selection Redo', command: { command: 'redo' }, prepareUndo: 0, nodes: graph, cursor: 5, changed: true },
  { name: 'content Undo', command: { command: 'undo' }, prepareUndo: 2, nodes: graph, cursor: 1, changed: true },
  { name: 'content Redo', command: { command: 'redo' }, prepareUndo: 3, nodes: graph, cursor: 2, changed: true },
];
const cases = scenarios.flatMap(scenario => (scenario.name === 'no-op Add' || scenario.name === 'content Undo'
  ? ['commit request', 'commit ACK'] as const : ['commit ACK'] as const).map(phase => ({ scenario, phase })));

test.beforeEach(async ({ page }) => {
  await page.goto('/e2e/operation-harness.html');
  await expect.poll(() => page.evaluate(() => window.operationHarness?.ready() ?? false)).toBe(true);
  expect(await page.evaluate(() => window.geometryViewerError)).toBeUndefined();
  await page.evaluate(() => window.operationHarness.load()); await settled(page);
});

for (const { scenario, phase } of cases) {
  test(`actual worker loss after ${scenario.name} at held ${phase} preserves the accepted graph without replay`, async ({ page }, testInfo) => {
    const fixture = await snapshot(page);
    for (let index = 0; index < scenario.prepareUndo; index++) await command(page, { command: 'undo' });
    const before = await snapshot(page), node = scenario.nodes[scenario.cursor];
    oracle(before, fixture, graph[4 - scenario.prepareUndo]);
    await page.evaluate(() => window.operationHarness.clear());
    await page.evaluate(({ command, phase }) => {
      window.operationHarness.wireFaults([{ direction: phase === 'commit request' ? 'request' : 'response',
        type: phase === 'commit request' ? 'operation' : 'operation-result', action: 'commit', effect: 'hold' }]);
      window.operationHarness.start(command);
    }, { command: scenario.command, phase });
    await expect.poll(async () => {
      const evidence = await trace(page);
      return phase === 'commit request'
        ? evidence.requests.some(request => request.type === 'operation' && request.action === 'commit' && !request.forwarded)
        : evidence.responses.some(response => response.type === 'operation-result' && response.action === 'commit' && !response.delivered);
    }).toBe(true);
    const decided: State = await state(page), held = await trace(page);
    const terminal = held.responses.findIndex(response => response.type === 'operation-result' && response.action === 'commit' && !response.delivered);
    expect(decided.busy).toBe(true); expect(decided.checkpoint).not.toBeNull();
    expect(decided.checkpoint!.plan).toMatchObject({ revision: before.summary.revision + Number(scenario.changed), contentRevision: node.content });
    expect(decided.document).toEqual({ ...before.document,
      selectionRevision: before.document.selectionRevision + Number(scenario.changed),
      contentRevision: before.document.contentRevision + Number(node.content !== before.summary.contentRevision) });
    // A no-op still owns an irreversible decision; identical revisions or root
    // bytes cannot distinguish acceptance from its predecessor.
    expect(decided.checkpoint!.binding.revision).toEqual(decided.document);
    expect(await page.evaluate(() => window.operationHarness.gpu())).toEqual(before.gpu);
    if (phase === 'commit ACK') {
      expect(terminal).toBeGreaterThanOrEqual(0);
      expect(held.responses[terminal].data.receipt).toMatchObject({ outcome: 'committed' });
      expect(held.responses[terminal].data.summary).toMatchObject({ transaction: false,
        revision: before.summary.revision + Number(scenario.changed), contentRevision: node.content,
        canUndo: scenario.cursor > 0, canRedo: scenario.cursor < scenario.nodes.length - 1 });
    } else expect(terminal).toBe(-1);
    await page.evaluate(id => window.operationHarness.failWorker(id), before.authoritativeWorker);
    await settled(page); expect(await page.evaluate(() => window.operationHarness.join())).toBe(true);
    const after = await snapshot(page), evidence = await trace(page);
    oracle(after, before, node); replacement(after, before, evidence, scenario.command.command);
    expect(after.document).toEqual(decided.document);
    expect(after.summary.revision).toBe(before.summary.revision + Number(scenario.changed));
    expect(after.summary.canUndo).toBe(scenario.cursor > 0); expect(after.summary.canRedo).toBe(scenario.cursor < scenario.nodes.length - 1);
    expect(after.checkpoint!.rootSha256).toBe(decided.checkpoint!.rootSha256);
    expect(evidence.requests.filter(request => request.worker === before.authoritativeWorker && request.type === 'command' && request.command === scenario.command.command && request.forwarded)).toHaveLength(1);
    expect(evidence.requests.filter(request => request.type === 'operation' && request.action === 'commit' && request.forwarded))
      .toHaveLength(phase === 'commit ACK' ? 1 : 0);
    if (terminal >= 0) {
      await page.evaluate(index => window.operationHarness.release(index, 2), terminal);
      const late = await snapshot(page);
      expect(late.document).toEqual(after.document); expect(late.outputs).toEqual(after.outputs);
      expect(late.gpu).toEqual(after.gpu); expect(late.checkpoint!.rootSha256).toBe(after.checkpoint!.rootSha256);
    }
    const final = await wholeHistory(page, before, scenario.nodes, scenario.cursor);
    await testInfo.attach('worker-history-recovery-evidence', { contentType: 'application/json',
      body: JSON.stringify({ scenario: scenario.name, phase, expectedGraph: scenario.nodes, expectedCursor: scenario.cursor,
        before, decided, held, after, evidence, historyVerified: true, final }) });
  });
}
