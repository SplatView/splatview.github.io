import { beforeAll, describe, expect, it } from 'vitest';
import { admittedNativeCommand } from './fixtures/native-export';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BUILD_DESCRIPTOR } from '../src/generated/buildIdentity';
import type { LivePreviewOutcome, NativeSummary } from '../src/document/types';
import type { ModuleFactory, WasmModule } from '../src/workers/wasm';
import { wasmString } from '../src/workers/wasm';
import { gaussianPly } from './fixtures/gaussians';

type NativeLiveResult = ({ ok: true } & LivePreviewOutcome) | { ok: false; error: string };
type Tool = 'polygon' | 'rectangle' | 'brush';
let core: WasmModule;
const camera = [0, 0, 0, 0, 0, 3, 1, 90, 1, 0];
const baseline = [1, 0, 1];
const decode = (pointer: number) => JSON.parse(core.UTF8ToString(pointer)) as NativeSummary;
const command = (value: unknown) => wasmString(core, JSON.stringify(admittedNativeCommand(core, value)), pointer => decode(core._sv_command(pointer)));
const liveText = (text: string) => wasmString(core, text,
  pointer => JSON.parse(core.UTF8ToString(core._sv_live_preview(pointer))) as NativeLiveResult);
const live = (value: unknown) => liveText(JSON.stringify(value));
const mask = () => Array.from(core.HEAPU8.slice(core._sv_states_ptr(), core._sv_states_ptr() + 3));

function prepare(draft = true) {
  const bytes = gaussianPly(0), pointer = core._malloc(bytes.length);
  try {
    core.HEAPU8.set(bytes, pointer);
    const loaded = decode(core._sv_open(pointer, bytes.length, 0, 1000, 32 * 1024 * 1024));
    expect(loaded.ok, loaded.error).toBe(true);
    expect(loaded.count).toBe(3);
  } finally { core._free(pointer); }
  // At distance 3, FOV 90 and a 100-square framebuffer these native centers
  // project to (20,50), (50,50), (80,50). Source order is the independent ID.
  // Set actual loaded geometry, following the core fixtures' native-memory
  // pattern, so decoder axes and camera fit do not obscure this selector test.
  [-1.8, 0, 1.8].forEach((x, index) => {
    new Float32Array(core.HEAPU8.buffer, core._sv_scene_ptr() + index * 144, 3).set([x, 0, 0]);
  });
  expect(command({ command: 'single', index: 0, operation: 0 }).ok).toBe(true);
  expect(command({ command: 'single', index: 2, operation: 1 }).ok).toBe(true);
  expect(command({ command: 'single', index: 1, operation: 1 }).ok).toBe(true);
  expect(command({ command: 'undo' }).canRedo).toBe(true);
  expect(mask()).toEqual(baseline);
  if (draft) expect(command({ command: 'beginSelection' }).selectionDraft).toBe(true);
}
function request(tool: Tool, operation = 0, narrow = false): Record<string, unknown> {
  const value: Record<string, unknown> = { command: tool, fromBaseline: true, width: 100, height: 100,
    camera, operation, visibleOnly: false, overlap: false };
  const left = narrow ? 10 : 40, right = narrow ? 30 : 90;
  if (tool === 'rectangle') value.rectangle = [left, 40, right, 60];
  else if (tool === 'polygon') value.points = [[left, 40], [right, 40], [right, 60], [left, 60]];
  else { value.points = narrow ? [[20, 50]] : [[50, 50], [80, 50]]; value.radius = 7; }
  return value;
}
function published(value: NativeLiveResult) {
  expect(Object.keys(value).sort()).toEqual(['kind', 'ok', 'summary', 'version']);
  expect(value).toMatchObject({ ok: true, kind: 'published', version: 1 });
  if (!value.ok || value.kind !== 'published') throw new Error('Expected a real published native result.');
  expect(value.summary).toMatchObject({ ok: true, loaded: true, selectionDraft: true, canRedo: true });
  return value.summary;
}
function snapshot() {
  return { summary: command({ command: 'summary' }), mask: mask(),
    scenePointer: core._sv_scene_ptr(), maskPointer: core._sv_states_ptr() };
}
function unchanged(before: ReturnType<typeof snapshot>) {
  expect(command({ command: 'summary' })).toEqual(before.summary);
  expect(mask()).toEqual(before.mask);
  expect(core._sv_scene_ptr()).toBe(before.scenePointer);
  expect(core._sv_states_ptr()).toBe(before.maskPointer);
}
function fatal(value: NativeLiveResult, before: ReturnType<typeof snapshot>) {
  expect(Object.keys(value).sort()).toEqual(['error', 'ok']);
  expect(value).toMatchObject({ ok: false, error: expect.any(String) });
  if (value.ok) throw new Error('A refused native preview must stay an ordinary fatal result.');
  expect(value.error.length).toBeGreaterThan(0);
  unchanged(before);
}
function selectedExportIds() {
  const exported = command({ command: 'export', format: 2, scope: 1 });
  expect(exported.ok, exported.error).toBe(true);
  const bytes = core.HEAPU8.slice(core._sv_output_ptr(), core._sv_output_ptr() + core._sv_output_len());
  expect(bytes.length % 32).toBe(0);
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const x = [-1.8, 0, 1.8].map(value => Math.fround(value));
  return Array.from({ length: bytes.length / 32 }, (_, record) => {
    const id = x.indexOf(data.getFloat32(record * 32, true));
    expect(id).toBeGreaterThanOrEqual(0); return id;
  });
}

beforeAll(async () => {
  const url = pathToFileURL(resolve('public/wasm/splatview-core.mjs')).href;
  const factory = (await import(/* @vite-ignore */ url) as { default: ModuleFactory }).default;
  core = await factory();
  // Read the real compiled static identity before any scene admission.
  expect(core._sv_abi_version()).toBe(BUILD_DESCRIPTOR.native.core.abi);
  const identity = JSON.parse(core.UTF8ToString(core._sv_build_identity()));
  expect(identity).toMatchObject({ kind: 'core', abi: BUILD_DESCRIPTOR.native.core.abi, capabilities: { liveSelectionOutcome: 1, allocationCensus: 1 } });
  expect(typeof core._sv_live_preview).toBe('function');
});

describe('real compiled live-preview ABI', () => {
  const cases = (['polygon', 'rectangle', 'brush'] as const).flatMap(tool =>
    [0, 1, 2, 3].map(operation => ({ tool, operation })));
  it.each(cases)('$tool Combine $operation recomputes a shrinking shape from the original baseline', ({ tool, operation }) => {
    prepare();
    const initial = command({ command: 'summary' });
    const broad = published(live(request(tool, operation)));
    expect(mask()).toEqual([[0, 1, 1], [1, 1, 1], [1, 0, 0], [0, 0, 1]][operation]);
    expect(broad.contentRevision).toBe(initial.contentRevision);
    const narrowed = published(live(request(tool, operation, true)));
    const expected = [[1, 0, 0], baseline, [0, 0, 1], [1, 0, 0]][operation];
    expect(mask()).toEqual(expected);
    expect(narrowed.contentRevision).toBe(initial.contentRevision);
    expect(core._sv_scene_ptr()).toBeGreaterThan(0);
    const confirmed = command({ command: 'confirmSelection' });
    expect(confirmed.ok, confirmed.error).toBe(true);
    expect(confirmed.selectionDraft).toBe(false);
    expect(selectedExportIds()).toEqual(expected.flatMap((selected, id) => selected ? [id] : []));
    if (operation === 1) {
      // Add returned exactly to its original baseline: no redundant history
      // item may replace the isolated Redo entry for source 1.
      expect(confirmed.canRedo).toBe(true);
      expect(command({ command: 'redo' }).canRedo).toBe(false);
      expect(mask()).toEqual([1, 1, 1]);
    } else {
      expect(confirmed.canRedo).toBe(false);
      command({ command: 'undo' }); expect(mask()).toEqual(baseline);
      command({ command: 'redo' }); expect(mask()).toEqual(expected);
      // Exactly one confirmed gesture separates baseline from final mask.
      command({ command: 'undo' }); command({ command: 'undo' }); expect(mask()).toEqual([1, 0, 0]);
    }
  });

  it.each(['polygon', 'rectangle', 'brush'] as const)('%s publishes a true no-op without revision or storage changes', tool => {
    prepare(); const before = snapshot();
    const result = published(live(request(tool, 1, true)));
    expect(result.revision).toBe(before.summary.revision);
    unchanged(before);
    const confirmed = command({ command: 'confirmSelection' });
    expect(confirmed.canRedo).toBe(true);
    command({ command: 'redo' }); expect(mask()).toEqual([1, 1, 1]);
  });

  it.each([
    { name: 'two-vertex polygon', value: { ...request('polygon'), points: [[20, 50], [50, 50]] } },
    { name: 'collinear polygon', value: { ...request('polygon'), points: [[20, 50], [50, 50], [80, 50]] } },
    { name: 'empty direct brush', value: { ...request('brush'), points: [] } },
  ])('$name restores the original baseline as a completed result after a previous live preview', ({ value }) => {
    prepare(); published(live(request('polygon'))); expect(mask()).toEqual([0, 1, 1]);
    const result = published(live(value));
    expect(mask()).toEqual(baseline); expect(result.selected).toBe(2);
    expect(command({ command: 'confirmSelection' }).canRedo).toBe(true);
    command({ command: 'redo' }); expect(mask()).toEqual([1, 1, 1]);
  });

  it.each(['polygon', 'rectangle', 'brush'] as const)('%s cancellation preserves the original mask and actual Redo entry', tool => {
    prepare(); published(live(request(tool))); expect(mask()).toEqual([0, 1, 1]);
    const restored = command({ command: 'cancelSelection' });
    expect(restored).toMatchObject({ ok: true, selectionDraft: false, canRedo: true });
    expect(mask()).toEqual(baseline);
    command({ command: 'redo' }); expect(mask()).toEqual([1, 1, 1]);
  });

  it.each(['polygon', 'brush'] as const)('%s retires admitted path scratch before reporting published native memory', tool => {
    prepare(); const before = snapshot();
    expect(command({ command: 'beginTransaction' }).transaction).toBe(true);
    for (const narrow of [false, true]) {
      const publishedSummary = published(live(request(tool, 0, narrow)));
      const fresh = command({ command: 'summary' });
      // An independent subsequent native call observes the live payload after
      // the preview's admitted request/path owner has left its C++ scope.
      expect(publishedSummary.memoryBytes).toBe(fresh.memoryBytes);
      expect(publishedSummary).toEqual(fresh);
      expect(mask()).toEqual(narrow ? [1, 0, 0] : [0, 1, 1]);
      expect(fresh).toMatchObject({ transaction: true, selectionDraft: true,
        canUndo: before.summary.canUndo, canRedo: true, contentRevision: before.summary.contentRevision });
    }
    expect(command({ command: 'rollbackTransaction' }).transaction).toBe(false);
    unchanged(before);
    expect(command({ command: 'cancelSelection' }).canRedo).toBe(true);
    expect(command({ command: 'redo' }).canRedo).toBe(false); expect(mask()).toEqual([1, 1, 1]);
  });

  it.each([
    { name: 'no active draft', draft: false, value: request('polygon') },
    { name: 'fromBaseline false', draft: true, value: { ...request('polygon'), fromBaseline: false } },
    { name: 'missing fromBaseline', draft: true, value: { ...request('polygon'), fromBaseline: undefined } },
  ])('$name remains fatal without authoritative mutation', ({ draft, value }) => {
    prepare(draft); const before = snapshot(); fatal(live(value), before);
    if (draft) command({ command: 'cancelSelection' });
    expect(command({ command: 'redo' }).ok).toBe(true); expect(mask()).toEqual([1, 1, 1]);
  });

  it.each([
    { name: 'unsupported command', value: { ...request('polygon'), command: 'delete' } },
    { name: 'zero viewport', value: { ...request('polygon'), width: 0 } },
    { name: 'fractional viewport', value: { ...request('polygon'), height: 1.5 } },
    { name: 'invalid camera', value: { ...request('polygon'), camera: [0, 0, 0, 0, 0, 0, 1, 90, 1, 0] } },
    { name: 'invalid combination', value: { ...request('polygon'), operation: 4 } },
    { name: 'fractional path coordinate', value: { ...request('polygon'), points: [[1.5, 2], [3, 4], [5, 6]] } },
    { name: 'overflowing path coordinate', value: { ...request('polygon'), points: [[2 ** 31, 2], [3, 4], [5, 6]] } },
    { name: 'malformed rectangle', value: { ...request('rectangle'), rectangle: [1, 2, 3] } },
    { name: 'invalid radius', value: { ...request('brush'), radius: 4097 } },
    { name: 'visible brush without a map', value: { ...request('brush'), visibleOnly: true, mapId: 1 } },
  ])('$name remains fatal after a prior published preview and preserves draft, mask, Redo and ledger', ({ value }) => {
    prepare(); published(live(request('polygon')));
    const before = snapshot(); fatal(live(value), before);
    command({ command: 'cancelSelection' }); expect(mask()).toEqual(baseline);
    command({ command: 'redo' }); expect(mask()).toEqual([1, 1, 1]);
  });

  it.each(['{', 'null', '[]'])('malformed native input %s remains fatal without changing an accepted preview', text => {
    prepare(); published(live(request('rectangle')));
    const before = snapshot(); fatal(liveText(text), before);
  });

  it('rolls back a published preview through the real outer native transaction without losing baseline or Redo', () => {
    prepare(); const before = snapshot();
    expect(command({ command: 'beginTransaction' }).transaction).toBe(true);
    expect(published(live(request('polygon'))).transaction).toBe(true);
    expect(mask()).toEqual([0, 1, 1]);
    expect(command({ command: 'rollbackTransaction' }).transaction).toBe(false);
    unchanged(before);
    command({ command: 'cancelSelection' });
    command({ command: 'redo' }); expect(mask()).toEqual([1, 1, 1]);
  });
});
