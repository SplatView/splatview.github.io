import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { deepEqual as assertDeepEqual } from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { BUILD_DESCRIPTOR } from '../src/generated/buildIdentity';
import type { NativeSummary } from '../src/document/types';
import type { RecoveryCheckpointPlan as Plan } from '../src/document/recoveryCheckpoint';
import type { DuplicateRange } from '../src/document/duplicateProtocol';
import { wasmString, type ModuleFactory, type WasmModule } from '../src/workers/wasm';
import { gaussianPly } from './fixtures/gaussians';

type Checkpoint = { plan: Plan; bytes: Uint8Array; originalSourceCount: number };
type RestoreExpected = { codecVersion: number; currentLoadedCount: number; currentSourceCount: number;
  currentDuplicateRange: DuplicateRange; maximumGraphSplats: number; originalSourceCount: number;
  revision: number; contentRevision: number; nextContentRevision: number };
const budget = 128 * 1024 * 1024;
const originalSourceCounts = new WeakMap<WasmModule, number>();
let factory: ModuleFactory;
let core: WasmModule;
const decode = <T = NativeSummary>(module: WasmModule, pointer: number) => JSON.parse(module.UTF8ToString(pointer)) as T;
const command = (module: WasmModule, value: unknown) => wasmString(module, JSON.stringify(value), p => decode(module, module._sv_command(p)));
const summary = (module = core) => command(module, { command: 'summary' });
function accepted(value: NativeSummary) { expect(value.ok, value.error).toBe(true); return value; }
function open(module = core, bytes = gaussianPly(), maximumSplats = 1000, bytesBudget = budget) {
  const pointer = module._malloc(bytes.length);
  try { module.HEAPU8.set(bytes, pointer); const result = accepted(decode(module, module._sv_open(pointer, bytes.length, 0, maximumSplats, bytesBudget)));
    originalSourceCounts.set(module, result.sourceCount);return result; }
  finally { module._free(pointer); }
}
function finish(module: WasmModule, value: NativeSummary) {
  accepted(value);
  for (let n = 0; value.pending; n++) { expect(n).toBeLessThan(1000); value = accepted(decode(module, module._sv_step(7))); }
  return value;
}
const run = (value: unknown, module = core) => finish(module, command(module, value));
function records(module = core, count = summary(module).count) {
  const pointer = module._sv_scene_ptr();return module.HEAPU8.slice(pointer, pointer + count * 144);
}
function mask(module = core, count = summary(module).count) {
  const pointer = module._sv_states_ptr();return module.HEAPU8.slice(pointer, pointer + count);
}
function state(module = core) {
  const current = summary(module);
  const { memoryBytes: _memory, ...scalars } = current;
  return { summary: scalars, records: current.kind === 0 ? records(module, current.count) : undefined,
    mask: current.kind === 0 ? mask(module, current.count) : undefined };
}
function durableState(module = core) {
  const current = state(module);
  // Worker-local notification/history stamps reset on recovery. Keep every durable
  // scalar, record byte and mask byte in cross-worker checkpoint comparisons.
  // Atomic refusal and same-worker observations continue to use strict state().
  const { selectionCommitRevision: _notification, undoSelectionRevision: _historyStamp, ...summary } = current.summary;
  return { ...current, summary };
}
function capture(module = core, sizes = [19, 1024 * 1024, 97, 2]): Checkpoint {
  const plan = decode<Plan>(module, module._sv_recovery_prepare());
  expect(plan.ok, JSON.stringify(plan)).toBe(true);expect(plan.version).toBe(2);
  expect(plan.maximumChunkBytes).toBe(1024 * 1024);
  const bytes = new Uint8Array(plan.byteLength);
  try {
    for (let at = 0, index = 0; at < bytes.length; index++) {
      const count = Math.min(sizes[index % sizes.length], bytes.length - at);
      const pointer = module._sv_recovery_read(at, count);
      expect(pointer).toBeGreaterThan(0);expect(module._sv_recovery_read_size()).toBe(count);
      bytes.set(module.HEAPU8.subarray(pointer, pointer + count), at);at += count;
    }
  } finally { module._sv_recovery_release(); }
  expect(createHash('sha256').update(bytes.subarray(64)).digest('hex')).toBe(plan.sha256);
  expect(createHash('sha256').update(bytes.subarray(0, 64)).digest('hex')).toBe(plan.headerSha256);
  const originalSourceCount = originalSourceCounts.get(module);
  if (!originalSourceCount) throw new Error('Checkpoint fixture has no authenticated original import count.');
  return { plan, bytes, originalSourceCount };
}
function expectation(checkpoint: Checkpoint, maximumGraphSplats = checkpoint.plan.maximumGraphSplats): RestoreExpected {
  const plan = checkpoint.plan;
  return { codecVersion: 3, currentLoadedCount: plan.currentLoadedCount, currentSourceCount: plan.currentSourceCount,
    currentDuplicateRange: plan.currentDuplicateRange, maximumGraphSplats, originalSourceCount: checkpoint.originalSourceCount,
    revision: plan.revision, contentRevision: plan.contentRevision, nextContentRevision: plan.nextContentRevision };
}
function begin(module: WasmModule, checkpoint: Checkpoint, maximumSplats = checkpoint.plan.maximumGraphSplats, bytesBudget = budget,
  expected: RestoreExpected = expectation(checkpoint, maximumSplats)) {
  return wasmString(module, JSON.stringify(expected), pointer => decode(module,
    module._sv_recovery_restore_begin(checkpoint.bytes.length, maximumSplats, bytesBudget, pointer)));
}
function write(module: WasmModule, offset: number, bytes: Uint8Array) {
  const pointer = module._malloc(bytes.length || 1);
  try { module.HEAPU8.set(bytes, pointer);return decode(module, module._sv_recovery_restore_write(offset, pointer, bytes.length)); }
  finally { module._free(pointer); }
}
function restore(module: WasmModule, checkpoint: Checkpoint, maximumSplats = checkpoint.plan.maximumGraphSplats, bytesBudget = budget,
  expected = expectation(checkpoint, maximumSplats)) {
  const started = begin(module, checkpoint, maximumSplats, bytesBudget, expected);
  if (!started.ok) return started;
  const { bytes } = checkpoint;
  try {
    for (let at = 0; at < bytes.length; at += 65521) accepted(write(module, at, bytes.subarray(at, at + 65521)));
    const result = decode(module, module._sv_recovery_restore_finish());
    if (result.ok) originalSourceCounts.set(module, checkpoint.originalSourceCount);
    return result;
  } finally { module._sv_recovery_restore_cancel(); }
}
function rehash(bytes: Uint8Array) {
  bytes.set(createHash('sha256').update(bytes.subarray(64)).digest(), 24);return bytes;
}
function fieldOffsets(bytes: Uint8Array) {
  // Independent v3 framing reader used only to locate adversarial fields. It
  // does not supply native scenes, graph owners, deltas or validation outcomes.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 64;
  const u32 = () => { const v = view.getUint32(at, true);at += 4;return v; };
  const skip = (n: number) => { at += n; };
  const bool = () => !!bytes[at++];
  u32();const sceneCount = u32(), maskCount = u32();skip(4 + 4 + 1 + 24 + 8 + 48 + 16 + 96);
  const scenes: { sourceCount: number; gaussians: number; count: number; counts: number; marker: number }[] = [];
  for (let n = 0; n < sceneCount; n++) {
    skip(1 + 8 + 1 + 12 + 4);if (bool()) skip(12);if (bool()) skip(12 + 4 * 4 + 1 + 4);
    skip(64);const sourceCount = at;skip(8 + 4 + 1 + 8 + 8);
    for (let k = 0; k < 3; k++) skip(u32());
    const counts = at, ng = u32(), nv = u32(), nt = u32(), marker = at;if (bool()) skip(8);const gaussians = at;
    scenes.push({ sourceCount, gaussians, count: ng, counts, marker });skip(144 * ng + 16 * nv + 12 * nt);
  }
  const masks: { at: number; count: number }[] = [];
  for (let n = 0; n < maskCount; n++) { const count = u32();masks.push({ at, count });skip(count); }
  const revisions: { at: number; count: number; changes: number }[] = [];
  for (let direction = 0; direction < 2; direction++) {
    const count = u32();for (let n = 0; n < count; n++) { const start = at;skip(16 + 16);const changes = u32();revisions.push({ at: start, count: changes, changes: at });skip(changes * 6); }
  }
  if (bool()) skip(4 + 41 + 60 + 40 + 1 + 4); // Color base/context/applied/IDs/scope/effective mask.
  if (bool()) skip(4 + 4 + 33); // Alignment base/mask/context.
  let transformMatrix: number | undefined, opacityScale: number | undefined;
  if (bool()) {
    skip(4 + 4 + 33 + 24);if (bool()) skip(8);skip(3 + 148);
    skip(4);transformMatrix = at;skip(64 + 4 * 96 + 12 + 4);
  }
  if (bool()) {skip(4 + 4 + 33 + 24);if (bool()) skip(8);skip(1);opacityScale = at;skip(4 + 4);}
  return { view, scenes, masks, revisions, transformMatrix, opacityScale };
}
const neutral = [1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const grade = (brightness: number) => ({ command: 'grade', values: [brightness, ...neutral.slice(1)], selectedOnly: false });
const parameters = (translation = [1, 2, 3]) => ({ mode: 'euler', translation, scale: [1.2, .8, 1.1], pivot: [.1, .2, .3], flips: [false, false, false], euler: [10, -20, 30] });
const camera = [0, 0, 0, 0, 0, 3, 1, 45, 1, 0, 1.6];

beforeAll(async () => {
  const url = pathToFileURL(resolve('public/wasm/splatview-core.mjs')).href;
  factory = (await import(/* @vite-ignore */ url) as { default: ModuleFactory }).default;
});
beforeEach(async () => { core = await factory();expect(core._sv_abi_version()).toBe(BUILD_DESCRIPTOR.native.core.abi);open(); });
afterEach(() => { core._sv_recovery_release();core._sv_recovery_restore_cancel(); });

describe('real native exact document checkpoint foundation', () => {
  it('restores historical Undo entries without runtime selection stamps and stamps only a new accepted selection', async () => {
    const selected = run({ command: 'single', index: 0 });
    expect(selected.undoSelectionRevision).toBe(selected.revision); expect(selected.undoSelectionRevision).toBeGreaterThan(0);
    const checkpoint = capture(), original = state(), target = await factory(), restored = accepted(restore(target, checkpoint));
    expect(restored.canUndo).toBe(true); expect(restored.undoSelectionRevision).toBe(0);
    expect(durableState(target)).toEqual(durableState()); expect(state()).toEqual(original);
    expect(capture(target).bytes).toEqual(checkpoint.bytes);
    expect(run({ command: 'undo' }, target).undoSelectionRevision).toBe(0);
    expect(run({ command: 'redo' }, target).undoSelectionRevision).toBe(0);
    const changed = run({ command: 'single', index: 1 }, target);
    expect(changed.undoSelectionRevision).toBe(changed.revision); expect(changed.undoSelectionRevision).toBeGreaterThan(restored.revision);
    expect(mask(target)).toEqual(new Uint8Array([0, 1, 0]));
  });
  it('restarts only the worker-local selection event and reports committed selected-bit changes after exact restoration', async () => {
    expect(summary()).toHaveProperty('selectionCommitRevision', 0);
    expect(run({ command: 'single', index: 0 }).selectionCommitRevision).toBe(1);
    const replaced = run({ command: 'single', index: 1 });
    expect(replaced.selected).toBe(1);expect(replaced.selectionCommitRevision).toBe(2);
    expect(mask()).toEqual(new Uint8Array([0, 1, 0]));
    run(grade(1.2));expect(run({ command: 'endColor' }).selectionCommitRevision).toBe(2);
    const checkpoint = capture(), target = await factory();
    expect(summary(target)).toHaveProperty('selectionCommitRevision', 0);
    expect(accepted(restore(target, checkpoint))).toHaveProperty('selectionCommitRevision', 0);
    expect(durableState(target)).toEqual(durableState());
    // The source event is 2 and the restored event is 0, yet all codec bytes
    // are identical: the notification is deliberately absent from the format.
    expect(summary().selectionCommitRevision).toBe(2);expect(capture(target).bytes).toEqual(checkpoint.bytes);
    expect(run({ command: 'single', index: 1 }, target).selectionCommitRevision).toBe(0);
    expect(run({ command: 'undo' }, target).selectionCommitRevision).toBe(0);
    expect(run({ command: 'redo' }, target).selectionCommitRevision).toBe(0);
    const changed = run({ command: 'single', index: 2 }, target);
    expect(changed.selected).toBe(1);expect(changed.selectionCommitRevision).toBe(1);
    expect(mask(target)).toEqual(new Uint8Array([0, 0, 1]));
    expect(run({ command: 'undo' }, target).selectionCommitRevision).toBe(2);
    expect(mask(target)).toEqual(new Uint8Array([0, 1, 0]));
    expect(run({ command: 'redo' }, target).selectionCommitRevision).toBe(3);
    expect(mask(target)).toEqual(new Uint8Array([0, 0, 1]));
  });

  it('streams deterministic explicit bytes in arbitrary bounded ranges and locks mutation until release', () => {
    const before = state(), beforeMemory = summary().memoryBytes;const plan = decode<Plan>(core, core._sv_recovery_prepare());
    expect(plan.workspaceBytes).toBeGreaterThan(0);expect(plan.memoryBytes).toBeGreaterThan(beforeMemory);
    expect(plan).toMatchObject({ sceneCount: 1, maskCount: 1, actualRevision: 0, revision: 0, contentRevision: 0, nextContentRevision: 0, normalizationFlags: 0 });
    expect(command(core, { command: 'single', index: 1 }).ok).toBe(false);
    expect(decode(core, core._sv_step(1)).ok).toBe(false);
    expect(core._sv_recovery_read(0, 0)).toBe(0);expect(core._sv_recovery_read_size()).toBe(0);
    expect(core._sv_recovery_read(plan.byteLength, 1)).toBe(0);
    expect(core._sv_recovery_read(0, 1048577)).toBe(0);
    core._sv_recovery_release();expect(state()).toEqual(before);
    const first = capture(), second = capture(core, [1, 17, 53, 1048576]);
    expect(second.bytes).toEqual(first.bytes);expect(first.plan.headerSha256).toBe(second.plan.headerSha256);
    expect(new TextDecoder().decode(first.bytes.subarray(0, 8))).toBe('SVCKPT01');
    expect(new DataView(first.bytes.buffer).getBigUint64(16, true)).toBe(BigInt(first.bytes.length));
    accepted(command(core, { command: 'single', index: 1 }));
  });

  it.each([0, 1, 2, 3])('preserves all144 native Gaussian bytes at SH degree%i, including opaque reserved words', async degree => {
    open(core, gaussianPly(degree));
    // A white-box ABI fixture: seed otherwise opaque lanes with distinct bits.
    // These bytes cannot be reconstructed by PLY or a lossy GPU packet.
    const pointer = core._sv_scene_ptr(), view = new DataView(core.HEAPU8.buffer);
    for (let n = 0; n < 3; n++) {
      view.setUint32(pointer + n * 144 + 40, 0x7fc01234 + n, true);
      view.setUint32(pointer + n * 144 + 44, 0x80000000 + n, true);
      for (let k = 0; k < 24; k++) view.setUint32(pointer + n * 144 + 48 + 4 * k, (0x7e01fc00 + 0x12345 * k + n) >>> 0, true);
    }
    const before = records(), checkpoint = capture(), target = await factory();
    accepted(restore(target, checkpoint));expect(records(target)).toEqual(before);
    expect(capture(target).bytes).toEqual(checkpoint.bytes);
  });

  it('roundtrips ordered Undo and Redo plus deleted masks and consumed content highwater after branching', async () => {
    run({ command: 'single', index: 0 });run({ command: 'delete' });run({ command: 'undo' });
    const consumed = capture().plan.nextContentRevision;
    run({ command: 'single', index: 1 });run({ command: 'delete' });run({ command: 'undo' });
    const checkpoint = capture(), target = await factory();accepted(restore(target, checkpoint));
    expect(durableState(target)).toEqual(durableState());expect(capture(target).bytes).toEqual(checkpoint.bytes);
    for (const action of ['redo', 'undo', 'undo', 'redo', 'redo', 'undo']) {
      run({ command: action });run({ command: action }, target);expect(durableState(target)).toEqual(durableState());
    }
    run({ command: 'single', index: 2 });run({ command: 'delete' });
    run({ command: 'single', index: 2 }, target);run({ command: 'delete' }, target);
    expect(durableState(target)).toEqual(durableState());expect(summary(target).contentRevision).toBeGreaterThan(consumed);
  });

  it('shares exact scene graph nodes through a mixed scene/mask history and restores every retained history position', async () => {
    run({ command: 'single', index: 0 });run({ command: 'delete' });run(grade(1.4));run({ command: 'endColor' });
    run({ command: 'restore' });run({ command: 'single', index: 2 });run({ command: 'delete' });run({ command: 'undo' });
    const checkpoint = capture();expect(checkpoint.plan.sceneCount).toBe(2);
    const target = await factory();accepted(restore(target, checkpoint));
    for (let i = 0; i < 10; i++) {
      expect(durableState(target)).toEqual(durableState());if (!summary().canUndo) break;
      run({ command: 'undo' });run({ command: 'undo' }, target);
    }
    for (let i = 0; i < 10; i++) {
      expect(durableState(target)).toEqual(durableState());if (!summary().canRedo) break;
      run({ command: 'redo' });run({ command: 'redo' }, target);
    }
  });

  it('admits sampled scenes by loaded count while preserving larger original source metadata', async () => {
    const loaded = open(core, gaussianPly(), 1);expect(loaded.count).toBe(1);expect(loaded.sourceCount).toBe(3);
    const checkpoint = capture(), target = await factory();accepted(restore(target, checkpoint, 1));
    expect(durableState(target)).toEqual(durableState());expect(capture(target).bytes).toEqual(checkpoint.bytes);
  });

  it('restores grown records and suffix owners, including a smaller current with a larger Redo graph', async () => {
    const beforeRecords = records();run({ command: 'single', index: 1 });run({ command: 'delete' });
    run({ command: 'single', index: 0 });run({ command: 'single', index: 2, operation: 1 });
    const beforeDuplicate = state();const grown = run({ command: 'duplicate' });
    expect(grown).toMatchObject({ count: 5, sourceCount: 5, selected: 2, visible: 4, duplicateRange: { first: 3, count: 2 } });
    expect(records().subarray(0, 3 * 144)).toEqual(beforeRecords);
    expect(mask()).toEqual(new Uint8Array([0, 2, 0, 1, 1]));
    const checkpoint = capture();expect(checkpoint.originalSourceCount).toBe(3);
    expect(checkpoint.plan).toMatchObject({ currentLoadedCount: 5, currentSourceCount: 5,
      currentDuplicateRange: { first: 3, count: 2 }, maximumGraphSplats: 5 });
    const target = await factory();accepted(restore(target, checkpoint));expect(durableState(target)).toEqual(durableState());
    run({ command: 'undo' });run({ command: 'undo' }, target);expect(durableState(target)).toEqual(durableState());
    expect(records()).toEqual(beforeDuplicate.records);expect(mask()).toEqual(beforeDuplicate.mask);
    const smaller = capture();expect(smaller.plan).toMatchObject({ currentLoadedCount: 3, currentSourceCount: 3,
      currentDuplicateRange: null, maximumGraphSplats: 5 });
    const recovered = await factory();accepted(restore(recovered, smaller));
    run({ command: 'redo' }, recovered);run({ command: 'redo' }, target);expect(durableState(recovered)).toEqual(durableState(target));
    expect(summary(recovered).duplicateRange).toEqual({ first: 3, count: 2 });
    const prior = state(recovered);
    for (const changed of [{ currentLoadedCount: 4 }, { currentSourceCount: 6 }, { currentDuplicateRange: null },
      { currentDuplicateRange: { first: 2, count: 3 } }, { revision: checkpoint.plan.revision + 1 },
      { contentRevision: checkpoint.plan.contentRevision - 1 }, { nextContentRevision: checkpoint.plan.nextContentRevision + 1 }]) {
      expect(restore(recovered, checkpoint, 5, budget, { ...expectation(checkpoint), ...changed }).ok).toBe(false);
      expect(state(recovered)).toEqual(prior);
    }
    expect(restore(recovered, checkpoint, 6).ok).toBe(false);expect(state(recovered)).toEqual(prior);
    expect(restore(recovered, smaller, 3).ok).toBe(false);expect(state(recovered)).toEqual(prior);
    const fields = fieldOffsets(checkpoint.bytes), marker = fields.scenes[0].marker;
    for (const [offset, value] of [[marker + 1, 2], [marker + 5, 0], [marker + 1, 0xffff_ffff]]) {
      const bytes = checkpoint.bytes.slice();new DataView(bytes.buffer).setUint32(offset, value, true);rehash(bytes);
      expect(restore(recovered, { ...checkpoint, bytes }).ok).toBe(false);expect(state(recovered)).toEqual(prior);
    }
  });

  it('retains an allocated empty mask owner without confusing its null data pointer with no owner', async () => {
    // The file loader requires a nonempty scene. The native checkpoint/SceneEdits
    // domain separately admits allocated zero-length masks. Reach that state
    // through a valid explicit wire fixture and the actual restore API.
    const captured = capture(), seed = captured.bytes, fields = fieldOffsets(seed), scene = fields.scenes[0], maskField = fields.masks[0];
    const empty = new Uint8Array(seed.length - scene.count * 144 - maskField.count);
    const view = new DataView(seed.buffer);
    view.setUint32(scene.counts, 0, true);view.setUint32(maskField.at - 4, 0, true);
    const pieces = [seed.subarray(0, scene.gaussians), seed.subarray(scene.gaussians + scene.count * 144, maskField.at), seed.subarray(maskField.at + maskField.count)];
    let at = 0;for (const piece of pieces) {empty.set(piece, at);at += piece.length;}
    new DataView(empty.buffer).setBigUint64(16, BigInt(empty.length), true);rehash(empty);
    const emptyCheckpoint = { ...captured, bytes: empty, plan: { ...captured.plan, currentLoadedCount: 0, maximumGraphSplats: 1 } };
    expect(accepted(restore(core, emptyCheckpoint)).count).toBe(0);
    expect(capture().plan.maskCount).toBe(1);
    // A genuine admitted color edit creates two different empty physical mask
    // owners retained by scene history. Both data() pointers are null; owner
    // identity must keep them distinct while deduplicating their shared aliases.
    run(grade(1.2));
    const checkpoint = capture();expect(checkpoint.plan.sceneCount).toBe(2);expect(checkpoint.plan.maskCount).toBe(2);
    const target = await factory();accepted(restore(target, checkpoint));expect(capture(target).bytes).toEqual(checkpoint.bytes);
  });

  it('restores source geometry, RGBA colors, triangle indices and scene metadata through the same exact format', async () => {
    const input = new TextEncoder().encode('ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n0 0 0 255 0 0\n1 0 0 0 255 0\n0 1 0 0 0 255\n3 0 1 2\n');
    const loaded = open(core, input);expect(loaded.kind).toBe(2);
    const geometry = (module: WasmModule) => {
      const vertices = module._sv_geometry_range(0, 0, 3), vb = module.HEAPU8.slice(vertices, vertices + module._sv_geometry_range_len());
      const triangles = module._sv_geometry_range(1, 0, 3), ib = module.HEAPU8.slice(triangles, triangles + module._sv_geometry_range_len());return { vb, ib };
    };
    const before = geometry(core), checkpoint = capture(), target = await factory();expect(checkpoint.plan.maskCount).toBe(0);
    accepted(restore(target, checkpoint));expect(durableState(target)).toEqual(durableState());expect(geometry(target)).toEqual(before);expect(capture(target).bytes).toEqual(checkpoint.bytes);
    const marker = fieldOffsets(checkpoint.bytes).scenes[0].marker, bytes = new Uint8Array(checkpoint.bytes.length + 8);
    bytes.set(checkpoint.bytes.subarray(0, marker + 1));bytes[marker] = 1;
    new DataView(bytes.buffer).setUint32(marker + 1, 1, true);new DataView(bytes.buffer).setUint32(marker + 5, 2, true);
    bytes.set(checkpoint.bytes.subarray(marker + 1), marker + 9);new DataView(bytes.buffer).setBigUint64(16, BigInt(bytes.length), true);rehash(bytes);
    const prior = state(target);expect(restore(target, { ...checkpoint, bytes }).ok).toBe(false);
    expect(state(target)).toEqual(prior);expect(geometry(target)).toEqual(before);
  });

  it('retains applied absolute color and exact Reset base while cancelling a pending replacement bake only in recovered state', async () => {
    const base = records();run(grade(1.5));const applied = records();
    const pending = command(core, grade(2));accepted(pending);expect(pending.pending).toBe(true);
    const checkpoint = capture();expect(checkpoint.plan.normalizationFlags & (32 | 64)).toBe(32 | 64);
    expect(summary().pending).toBe(true);expect(summary().colorSession?.values[0]).toBe(2);expect(records()).toEqual(applied);
    const target = await factory();const restored = accepted(restore(target, checkpoint));
    expect(restored.pending).toBe(false);expect(restored.colorSession?.values[0]).toBe(1.5);expect(restored.colorSession?.applied[0]).toBe(1.5);expect(records(target)).toEqual(applied);
    finish(core, summary());expect(records()).not.toEqual(applied); // Export did not cancel the live job.
    run(grade(1), target);expect(records(target)).toEqual(base);expect(summary(target).colorSession?.sessionId).toBe(restored.colorSession?.sessionId);
  });

  it.each(['transform', 'opacity'] as const)('preserves applied absolute%s base, pending attempt fences and exact Reset', async kind => {
    const base = records();const beginValue = kind === 'transform' ? { command: 'beginTransform', kind: 'numeric', selectedOnly: false } : { command: 'beginOpacity', selectedOnly: false };
    const started = run(beginValue), session = kind === 'transform' ? started.transformSession! : started.opacitySession!, id = session.id;
    const apply = (epoch: number) => kind === 'transform' ? { command: 'applyTransform', id, epoch, parameters: parameters(epoch === 1 ? [1, 2, 3] : [3, 2, 1]) } : { command: 'applyOpacity', id, epoch, scale: epoch === 1 ? .4 : 2 };
    run(apply(1));const applied = records();const pending = command(core, apply(2));accepted(pending);expect(pending.pending).toBe(true);
    const checkpoint = capture(), target = await factory(), restored = accepted(restore(target, checkpoint));
    const recovered = kind === 'transform' ? restored.transformSession! : restored.opacitySession!;
    expect(recovered).toMatchObject({ id, epoch: 2, appliedEpoch: 1 });expect(restored.pending).toBe(false);expect(records(target)).toEqual(applied);
    const streamPointer = kind === 'transform' ? target._sv_pack_transform_base(id, recovered.baseId, 2, 0, 3) : target._sv_pack_opacity_base(id, recovered.baseId, 2, 0, 3);
    expect(streamPointer).toBeGreaterThan(0);const packet = target.HEAPU8.slice(streamPointer, streamPointer + target._sv_pack_len());
    const expectedPacket = new Uint8Array(3 * 136);
    for (let n = 0; n < 3; n++) {expectedPacket.set(base.subarray(n * 144, n * 144 + 40), n * 136);expectedPacket.set(base.subarray(n * 144 + 48, (n + 1) * 144), n * 136 + 40);}
    expect(packet).toEqual(expectedPacket);
    const baseMaskPointer = kind === 'transform' ? target._sv_transform_base_states_ptr(id, recovered.baseId, 2) : target._sv_opacity_base_states_ptr(id, recovered.baseId, 2);
    expect(baseMaskPointer).toBeGreaterThan(0);expect(target.HEAPU8.slice(baseMaskPointer, baseMaskPointer + 3)).toEqual(new Uint8Array(3));
    expect(command(target, apply(2)).ok).toBe(false);
    const revision = summary(target).revision;
    const repeated = kind === 'transform' ? { command: 'applyTransform', id, epoch: 3, parameters: parameters([1, 2, 3]) } : { command: 'applyOpacity', id, epoch: 3, scale: .4 };
    run(repeated, target);expect(records(target)).toEqual(applied);expect(summary(target).revision).toBe(revision);
    run({ command: kind === 'transform' ? 'resetTransform' : 'resetOpacity', id, epoch: 4 }, target);expect(records(target)).toEqual(base);
    run({ command: kind === 'transform' ? 'endTransform' : 'endOpacity', id }, target);
    run({ command: 'undo' }, target);expect(records(target)).toEqual(applied);run({ command: 'redo' }, target);expect(records(target)).toEqual(base);
    expect(summary().pending).toBe(true); // Recovery preparation never retires the source job.
  });

  it('preserves the exact alignment Reset baseline, frames and history branch lineage', async () => {
    const base = records();run({ command: 'single', index: 2 });run({ command: 'delete' });
    const before = records();const applied = run({ command: 'alignScale', points: [[0, 0, 0], [1, 0, 0]], target: 2, camera, defaultCamera: camera });
    expect(applied.alignment?.canReset).toBe(true);const scaled = records();expect(scaled).not.toEqual(base);
    const checkpoint = capture(), target = await factory();accepted(restore(target, checkpoint));expect(durableState(target)).toEqual(durableState());
    run({ command: 'resetAlignment', camera, defaultCamera: camera }, target);expect(records(target)).toEqual(before);
    run({ command: 'undo' }, target);expect(records(target)).toEqual(scaled);
    run({ command: 'undo' }, target);expect(records(target)).toEqual(before);
    run({ command: 'redo' }, target);expect(records(target)).toEqual(scaled);
    const restoredLineage = summary(target).alignment!;expect(restoredLineage.retainedBranchIds).toEqual(applied.alignment?.retainedBranchIds);
  });

  it('cancels an unfinished selection draft privately while preserving both history stacks and original live draft', async () => {
    run({ command: 'single', index: 0 });run({ command: 'delete' });run({ command: 'undo' });const baseline = mask();
    run({ command: 'beginSelection' });run({ command: 'single', index: 2 });const live = state(), checkpoint = capture();
    expect(checkpoint.plan.normalizationFlags & 1).toBe(1);expect(checkpoint.plan.revision).toBe(checkpoint.plan.actualRevision + 1);expect(state()).toEqual(live);
    const target = await factory(), restored = accepted(restore(target, checkpoint));expect(restored.selectionDraft).toBe(false);expect(restored.canRedo).toBe(true);expect(mask(target)).toEqual(baseline);
    run({ command: 'cancelSelection' });expect(durableState(target)).toEqual(durableState());
    run({ command: 'redo' });run({ command: 'redo' }, target);expect(durableState(target)).toEqual(durableState());
  });

  it('cancels an unfinished filter owner/preview and retains the committed selection plus Redo', async () => {
    run({ command: 'single', index: 0 });run({ command: 'delete' });run({ command: 'undo' });const baseline = mask();
    const started = run({ command: 'beginFilter', kind: 'sphere' }), id = started.filter!.id;
    run({ command: 'previewFilter', id, epoch: 1, kind: 'sphere', parameters: { center: [0, 0, 0], radius: 10 }, operation: 0 });
    expect(mask()).not.toEqual(baseline);const checkpoint = capture();expect(checkpoint.plan.normalizationFlags & 3).toBe(3);expect(summary().filter?.id).toBe(id);
    const target = await factory(), restored = accepted(restore(target, checkpoint));expect(restored.filter).toBeNull();expect(restored.selectionDraft).toBe(false);expect(restored.canRedo).toBe(true);expect(mask(target)).toEqual(baseline);
    run({ command: 'redo' }, target);expect(mask(target)).toEqual(new Uint8Array([2, 0, 0]));
  });

  it('drops the tolerance owner while retaining its already committed selection/history', async () => {
    const picked = run({ command: 'colorPick', sessionId: 1, tolerance: 0, index: 0, operation: 0, camera, rangeEnabled: true, rangeRadius: 1 });
    expect(picked.toleranceRange).toMatchObject({ enabled: true, radius: 1 }); expect(picked.toleranceRange!.center).not.toBeNull();
    const before = mask(), checkpoint = capture();expect(checkpoint.plan.normalizationFlags & 4).toBe(4);
    const target = await factory(), restored = accepted(restore(target, checkpoint));expect(restored.toleranceSessionId).toBeNull();expect(mask(target)).toEqual(before);
    expect(restored.toleranceRange).toBeNull(); expect(summary().toleranceRange).toEqual(picked.toleranceRange);
    run({ command: 'undo' }, target);expect(mask(target)).toEqual(new Uint8Array(3));run({ command: 'redo' }, target);expect(mask(target)).toEqual(before);
  });

  it('captures the tentative current outer transaction without changing its commit/rollback decision', async () => {
    const baseline = state();run({ command: 'beginTransaction' });run({ command: 'single', index: 1 });run({ command: 'delete' });
    const tentative = state(), checkpoint = capture();expect(summary().transaction).toBe(true);
    const target = await factory(), restored = accepted(restore(target, checkpoint));expect(restored.transaction).toBe(false);expect(mask(target)).toEqual(tentative.mask);
    run({ command: 'rollbackTransaction' });expect(records()).toEqual(baseline.records);expect(mask()).toEqual(baseline.mask);
    expect(mask(target)).toEqual(new Uint8Array([0, 2, 0]));run({ command: 'undo' }, target);expect(mask(target)).toEqual(new Uint8Array([0, 1, 0]));
  });

  it('refuses corrupt or truncated bytes atomically without replacing the prior document/history', async () => {
    run({ command: 'single', index: 0 });run({ command: 'delete' });run({ command: 'undo' });const checkpoint = capture();
    const target = await factory();open(target);run({ command: 'single', index: 2 }, target);const prior = state(target);
    const variants = [checkpoint.bytes.subarray(0, checkpoint.bytes.length - 1), ...[0, 8, 12, 16, 24, 56, 60, 64, checkpoint.bytes.length - 1].map(at => {
      const bytes = checkpoint.bytes.slice();bytes[at] ^= 128;return bytes;
    })];
    for (const bytes of variants) {expect(restore(target, { ...checkpoint, bytes }).ok).toBe(false);expect(state(target)).toEqual(prior);}
  });

  it('validates owner references, semantic scalars, ordered deltas and content highwater even with a recomputed digest', async () => {
    run({ command: 'selectAll' });run({ command: 'delete' });const checkpoint = capture();const offsets = fieldOffsets(checkpoint.bytes);
    const target = await factory();open(target);run({ command: 'single', index: 1 }, target);const before = state(target);
    const mutations = [
      (bytes: Uint8Array) => new DataView(bytes.buffer).setUint32(76, 0, true),
      (bytes: Uint8Array) => new DataView(bytes.buffer).setBigUint64(101, 0n, true),
      (bytes: Uint8Array) => { bytes[offsets.masks[0].at] = 3; },
      (bytes: Uint8Array) => new DataView(bytes.buffer).setUint32(offsets.scenes[0].gaussians, 0x7fc00000, true),
      (bytes: Uint8Array) => new DataView(bytes.buffer).setUint32(offsets.revisions[0].changes + 6, 0, true),
      (bytes: Uint8Array) => { bytes[offsets.revisions[0].changes + 5] = 0; },
    ];
    for (const mutate of mutations) {const bytes = checkpoint.bytes.slice();mutate(bytes);rehash(bytes);expect(restore(target, { ...checkpoint, bytes }).ok).toBe(false);expect(state(target)).toEqual(before);}
  });

  it('enforces sequential bounded input writes and leaves a refused owner available for exact retry or cancellation', async () => {
    const checkpoint = capture(), before = state();accepted(begin(core, checkpoint));
    expect(write(core, 1, checkpoint.bytes.subarray(0, 10)).ok).toBe(false);
    expect(write(core, 0, new Uint8Array()).ok).toBe(false);
    accepted(write(core, 0, checkpoint.bytes.subarray(0, 10)));
    expect(write(core, 0, checkpoint.bytes.subarray(0, 10)).ok).toBe(false);
    expect(decode(core, core._sv_recovery_restore_finish()).ok).toBe(false);
    expect(command(core, { command: 'selectAll' }).ok).toBe(false);
    accepted(write(core, 10, checkpoint.bytes.subarray(10)));accepted(decode(core, core._sv_recovery_restore_finish()));expect(state()).toEqual(before);
    accepted(begin(core, checkpoint));core._sv_recovery_restore_cancel();expect(state()).toEqual(before);expect(command(core, { command: 'selectAll' }).ok).toBe(true);
  });

  it('refuses finite transform matrix/plan disagreement and unapplied opacity scale with an otherwise valid digest', async () => {
    const target = await factory();open(target);run({ command: 'single', index: 1 }, target);const prior = state(target);
    const started = run({ command: 'beginTransform', kind: 'numeric', selectedOnly: false }), id = started.transformSession!.id;
    run({ command: 'applyTransform', id, epoch: 1, parameters: parameters() });
    const transformed = capture(), transformFields = fieldOffsets(transformed.bytes);expect(transformFields.transformMatrix).toBeTypeOf('number');
    const matrixBytes = transformed.bytes.slice(), matrixView = new DataView(matrixBytes.buffer), matrixAt = transformFields.transformMatrix! + 12 * 4;
    matrixView.setFloat32(matrixAt, matrixView.getFloat32(matrixAt, true) + 1, true);rehash(matrixBytes);
    expect(restore(target, { ...transformed, bytes: matrixBytes }).ok).toBe(false);expect(state(target)).toEqual(prior);
    open();run({ command: 'beginOpacity', selectedOnly: false });const opacity = capture(), opacityFields = fieldOffsets(opacity.bytes);
    expect(opacityFields.opacityScale).toBeTypeOf('number');const opacityBytes = opacity.bytes.slice();new DataView(opacityBytes.buffer).setFloat32(opacityFields.opacityScale!, 2, true);rehash(opacityBytes);
    expect(restore(target, { ...opacity, bytes: opacityBytes }).ok).toBe(false);expect(state(target)).toEqual(prior);
  });

  it('admits input and candidate concurrently and rejects loaded counts exceeding the restore policy without publishing', async () => {
    const checkpoint = capture(), before = state();
    expect(begin(core, checkpoint, checkpoint.plan.maximumGraphSplats, checkpoint.bytes.length - 1).ok).toBe(false);expect(state()).toEqual(before);
    expect(restore(core, checkpoint, 2).ok).toBe(false);expect(state()).toEqual(before);
    expect(begin(core, { ...checkpoint, bytes: new Uint8Array(63) }).ok).toBe(false);
    expect(begin(core, checkpoint, 0).ok).toBe(false);expect(state()).toEqual(before);
  });

  it('uses bounded export workspace rather than a second full Gaussian serialization buffer', async () => {
    const count = 20000, bytes = new Uint8Array(count * 32), view = new DataView(bytes.buffer);
    for (let i = 0; i < count; i++) {view.setFloat32(i * 32, i / 1000, true);for (let k = 0; k < 3; k++) view.setFloat32(i * 32 + 12 + k * 4, .01, true);bytes.set([128, 128, 128, 200, 255, 128, 128, 128], i * 32 + 24);}
    const pointer = core._malloc(bytes.length);
    try {core.HEAPU8.set(bytes, pointer);const loaded = accepted(decode(core, core._sv_open(pointer, bytes.length, 1, count, budget)));
      originalSourceCounts.set(core, loaded.sourceCount); } finally {core._free(pointer);}
    const before = summary(), checkpoint = capture();expect(checkpoint.plan.byteLength).toBeGreaterThan(count * 144);
    expect(checkpoint.plan.workspaceBytes).toBeLessThan(1200 * 1024);expect(checkpoint.plan.memoryBytes - before.memoryBytes).toBe(checkpoint.plan.workspaceBytes);
    expect(summary().memoryBytes).toBe(before.memoryBytes);
    const target = await factory();accepted(restore(target, checkpoint, count));assertDeepEqual(records(target), records());
  });
});
