import { beforeAll, describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { BUILD_DESCRIPTOR } from '../src/generated/buildIdentity';
import type { NativeSummary } from '../src/document/types';
import { wasmString, type ModuleFactory, type WasmModule } from '../src/workers/wasm';

type RecordValues = { position: number[]; covariance: number[]; opacity: number; sh: number[] };
type Case = { name: string; yUp: boolean; points: number[][]; target: number; requested: number[];
  inputCamera: { state: number[] }; members: { mask: number; before: RecordValues; after: RecordValues }[] };
const oracle = JSON.parse(readFileSync(resolve('tests/fixtures/alignment-scale-reference.json'), 'utf8')) as {
  cases: Case[]; seedPly: string; refusals: { name: string; target?: number }[];
};
let core: WasmModule;
const decode = (pointer: number) => JSON.parse(core.UTF8ToString(pointer)) as NativeSummary;
const command = (value: unknown) => wasmString(core, JSON.stringify(value), pointer => decode(core._sv_command(pointer)));
function step(result: NativeSummary) {
  for (let count = 0; result.pending; count++) {
    expect(count, 'The bounded fixture must finish').toBeLessThan(20);
    result = decode(core._sv_step(2)); expect(result.ok, result.error).toBe(true);
  }
  return result;
}
function records() {
  const base = core._sv_scene_ptr();
  return oracle.cases[0].members.map((_member, index) => {
    // Read the documented native Gaussian layout; never mutate a published scene.
    const floats = new Float32Array(core.HEAPU8.buffer, base + index * 144, 12).slice();
    const words = new Uint32Array(core.HEAPU8.buffer, base + index * 144 + 48, 24).slice();
    return { position: Array.from(floats.slice(0, 3)), covariance: Array.from(floats.slice(4, 10)),
      opacity: floats[3], sh: Array.from(words), padding: Array.from(floats.slice(10, 12)) };
  });
}
function masks() { return Array.from(core.HEAPU8.slice(core._sv_states_ptr(), core._sv_states_ptr() + 3)); }
function compare(actual: readonly number[], expected: readonly number[], relative: number, floor: number) {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((value, index) => {
    expect(Number.isFinite(value)).toBe(true);
    expect(Math.abs(value - expected[index]), `field ${index}: ${value} vs ${expected[index]}`)
      .toBeLessThanOrEqual(relative * Math.max(floor, Math.abs(expected[index])));
  });
}
function load() {
  const bytes = new TextEncoder().encode(oracle.seedPly), pointer = core._malloc(bytes.length);
  try {
    core.HEAPU8.set(bytes, pointer);
    const result = decode(core._sv_open(pointer, bytes.length, 0, 1000, 64 * 1024 * 1024));
    expect(result.ok, result.error).toBe(true); expect(result.count).toBe(3); expect(result.shDegree).toBe(3);
  } finally { core._free(pointer); }
  for (const value of [{ command: 'single', index: 2, operation: 0 }, { command: 'delete' },
    { command: 'single', index: 0, operation: 0 }]) {
    const result = command(value); expect(result.ok, result.error).toBe(true);
  }
  expect(masks()).toEqual([1, 0, 2]);
  return { records: records(), masks: masks(), summary: command({ command: 'summary' }) };
}
beforeAll(async () => {
  const url = pathToFileURL(resolve('public/wasm/splatview-core.mjs')).href;
  const factory = (await import(/* @vite-ignore */ url) as { default: ModuleFactory }).default;
  core = await factory();
  expect(core._sv_abi_version()).toBe(BUILD_DESCRIPTOR.native.core.abi);
  expect(BUILD_DESCRIPTOR.native.core.capabilities.alignment).toBe(4);
});

describe('actual published Scale job against captured Windows Affine fixtures', () => {
  it.each(oracle.cases.map((value, index) => ({ ...value, index })))('$name / yUp=$yUp preserves all three mask classes and matches the source oracle', value => {
    const before = load();
    before.records.forEach((record, index) => {
      // PLY axis/quaternion decoding is a distinct SSE/WASM conversion. Calibrate
      // its seed before comparing the actual job to the captured R0 Affine output.
      compare(record.position, value.members[index].before.position, 2e-5, 1e-8);
      compare(record.covariance, value.members[index].before.covariance, 5e-5, 1e-18);
    });
    expect(command({ command: 'beginTransaction' }).ok).toBe(true);
    const staged = step(command({ command: 'alignScale', points: value.points, target: value.target,
      camera: value.inputCamera.state, defaultCamera: value.inputCamera.state }));
    expect(staged.ok, staged.error).toBe(true); expect(staged.alignment?.canReset).toBe(true);
    compare(staged.alignment!.frame, value.requested, 2e-5, 1e-8);
    const after = records();
    after.forEach((record, index) => {
      compare(record.position, value.members[index].after.position, 2e-5, 1e-8);
      // A very small covariance must stay nonzero where the source does; this
      // relative floor does not let an all-zero result pass the minimum factor.
      compare(record.covariance, value.members[index].after.covariance, 5e-5, 1e-18);
      expect(record.opacity).toBe(before.records[index].opacity);
      expect(record.sh).toEqual(before.records[index].sh); expect(record.padding).toEqual(before.records[index].padding);
    });
    expect(masks()).toEqual(before.masks);
    expect(command({ command: 'commitTransaction' }).ok).toBe(true);
    expect(command({ command: 'beginTransaction' }).ok).toBe(true);
    const reset = command({ command: 'resetAlignment', camera: value.inputCamera.state, defaultCamera: value.inputCamera.state });
    expect(reset.ok, reset.error).toBe(true); expect(command({ command: 'commitTransaction' }).ok).toBe(true);
    expect(records()).toEqual(before.records); expect(masks()).toEqual(before.masks);
    // Reset owns the uninterrupted group. Subsequent history navigation retires
    // it; do not try to reset an old session after an Undo/Redo boundary.
    expect(command({ command: 'undo' }).ok).toBe(true); expect(records()).toEqual(after);
    expect(command({ command: 'undo' }).ok).toBe(true); expect(records()).toEqual(before.records);
    expect(command({ command: 'redo' }).ok).toBe(true); expect(records()).toEqual(after);
    expect(command({ command: 'redo' }).ok).toBe(true); expect(records()).toEqual(before.records);
  });
  it.each(oracle.refusals)('refuses source case $name without changing geometry, masks or executable history', value => {
    const before = load(), camera = oracle.cases[0].inputCamera.state;
    expect(command({ command: 'beginTransaction' }).ok).toBe(true);
    const result = command({ command: 'alignScale', points: value.name === 'coincident' ? [[0, 0, 0], [0, 0, 0]] :
      [[0, 0, 0], [1, 0, 0]], target: value.target ?? 1, camera, defaultCamera: camera });
    expect(result.ok).toBe(false);
    expect(result.error).toBe(value.name === 'below-factor' || value.name === 'above-factor' ?
      'The scale factor must be between 0.000001 and 1000000.' : 'Choose two distinct points and a positive target distance.');
    expect(command({ command: 'summary' }).pending).toBe(false);
    expect(command({ command: 'rollbackTransaction' }).ok).toBe(true);
    expect(records()).toEqual(before.records); expect(masks()).toEqual(before.masks);
    const after = command({ command: 'summary' });
    expect(after.alignment).toEqual(before.summary.alignment);
    expect(after.contentRevision).toBe(before.summary.contentRevision);
    expect(after.canUndo).toBe(before.summary.canUndo); expect(after.canRedo).toBe(before.summary.canRedo);
  });
});
