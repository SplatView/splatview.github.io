import { beforeAll, describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { BUILD_DESCRIPTOR } from '../src/generated/buildIdentity';
import type { NativeSummary } from '../src/document/types';
import { wasmString, type ModuleFactory, type WasmModule } from '../src/workers/wasm';

type RecordValues = { position: number[]; covariance: number[]; opacity: number; sh: number[] };
type PlaneCase = { name: string; yUp: boolean; flip: boolean; points: number[][]; normal: number[];
  requested: number[]; inputCamera: { state: number[] }; inputDefault: { state: number[] };
  members: { mask: number; before: RecordValues; after: RecordValues }[] };
const oracle = JSON.parse(readFileSync(resolve('tests/fixtures/alignment-plane-reference.json'), 'utf8')) as {
  seedPlyBase64: string; planeCases: PlaneCase[]; refusals: { name: string; points: number[][] }[];
};
let core: WasmModule;
const decode = (pointer: number) => JSON.parse(core.UTF8ToString(pointer)) as NativeSummary;
const command = (value: unknown) => wasmString(core, JSON.stringify(value), pointer => decode(core._sv_command(pointer)));
function finish(value: NativeSummary) {
  for (let count = 0; value.pending; count++) {
    expect(count, 'The bounded plane fixture must finish').toBeLessThan(20);
    value = decode(core._sv_step(2)); expect(value.ok, value.error).toBe(true);
  }
  return value;
}
function records() {
  const base = core._sv_scene_ptr();
  return Array.from({ length: 3 }, (_, index) => {
    // Read-only documented 144-byte Gaussian layout; published memory is never patched.
    const floats = new Float32Array(core.HEAPU8.buffer, base + index * 144, 12).slice();
    const words = new Uint32Array(core.HEAPU8.buffer, base + index * 144 + 48, 24).slice();
    return { position: Array.from(floats.slice(0, 3)), covariance: Array.from(floats.slice(4, 10)),
      opacity: floats[3], sh: Array.from(words), padding: Array.from(floats.slice(10, 12)) };
  });
}
const masks = () => Array.from(core.HEAPU8.slice(core._sv_states_ptr(), core._sv_states_ptr() + 3));
function compare(actual: readonly number[], expected: readonly number[], relative: number, floor: number) {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((value, index) => {
    expect(Number.isFinite(value)).toBe(true);
    expect(Math.abs(value - expected[index]), `field ${index}: ${value} vs ${expected[index]}`)
      .toBeLessThanOrEqual(relative * Math.max(floor, Math.abs(expected[index])));
  });
}
function half(bits: number) {
  const sign = bits & 0x8000 ? -1 : 1, exponent = bits >>> 10 & 31, mantissa = bits & 1023;
  return sign * (exponent === 0 ? mantissa * 2 ** -24 : exponent === 31 ? mantissa ? NaN : Infinity :
    (1 + mantissa / 1024) * 2 ** (exponent - 15));
}
function compareSh(actual: readonly number[], expected: readonly number[]) {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((word, index) => {
    for (const shift of [0, 16]) {
      const bits = expected[index] >>> shift & 65535, observed = half(word >>> shift & 65535), reference = half(bits);
      expect(Number.isFinite(observed)).toBe(true); expect(Number.isFinite(reference)).toBe(true);
      // Two storage ULPs bound cross-target arithmetic/half quantization. This
      // comparator decodes source output; it does not reconstruct SH rotation.
      const ulp = 2 ** (Math.max(1, bits >>> 10 & 31) - 25);
      expect(Math.abs(observed - reference), `SH half ${index * 2 + shift / 16}: ${observed} vs ${reference}`)
        .toBeLessThanOrEqual(2 * ulp);
    }
  });
}
function load() {
  // Actual captured binary PLY exporter supplies RDF XYZ/covariance/SH input.
  const bytes = Buffer.from(oracle.seedPlyBase64, 'base64'), pointer = core._malloc(bytes.length);
  try {
    core.HEAPU8.set(bytes, pointer);
    const opened = decode(core._sv_open(pointer, bytes.length, 0, 1000, 64 * 1024 * 1024));
    expect(opened.ok, opened.error).toBe(true); expect(opened.count).toBe(3); expect(opened.shDegree).toBe(3);
  } finally { core._free(pointer); }
  for (const request of [{ command: 'single', index: 2, operation: 0 }, { command: 'delete' },
    { command: 'single', index: 0, operation: 0 }]) expect(command(request).ok).toBe(true);
  expect(masks()).toEqual([1, 0, 2]);
  return { records: records(), masks: masks(), summary: command({ command: 'summary' }) };
}
beforeAll(async () => {
  const url = pathToFileURL(resolve('public/wasm/splatview-core.mjs')).href;
  core = await (await import(/* @vite-ignore */ url) as { default: ModuleFactory }).default();
  expect(core._sv_abi_version()).toBe(BUILD_DESCRIPTOR.native.core.abi);
  expect(BUILD_DESCRIPTOR.native.core.capabilities.alignment).toBe(4);
});

describe('actual published Plane job against captured Windows normal/Affine/SH fixtures', () => {
  it.each(oracle.planeCases)('$name / yUp=$yUp / flip=$flip transforms every mask class and restores exact history', value => {
    const before = load();
    before.records.forEach((record, index) => {
      // Calibrate PLY axis/quaternion decode independently before the job.
      compare(record.position, value.members[index].before.position, 2e-5, 1e-8);
      compare(record.covariance, value.members[index].before.covariance, 5e-5, 1e-18);
      compareSh(record.sh, value.members[index].before.sh);
    });
    const normal = command({ command: 'planeNormal', points: value.points });
    expect(normal.ok, normal.error).toBe(true); compare(normal.point!, value.normal, 2e-5, 1e-8);
    expect(records()).toEqual(before.records); expect(masks()).toEqual(before.masks);
    expect(command({ command: 'summary' })).toEqual(before.summary);
    expect(command({ command: 'beginTransaction' }).ok).toBe(true);
    const staged = finish(command({ command: 'alignPlane', points: value.points, flip: value.flip,
      camera: value.inputCamera.state, defaultCamera: value.inputDefault.state }));
    expect(staged.ok, staged.error).toBe(true); expect(staged.alignment?.canReset).toBe(true);
    // Fresh native source has an identity frame. The independent camera cases
    // separately qualify the oracle's nonidentity beforeFrame/delta variants.
    compare(staged.alignment!.frame, value.requested, 2e-5, 1e-8);
    const after = records();
    after.forEach((record, index) => {
      compare(record.position, value.members[index].after.position, 3e-5, 1e-7);
      compare(record.covariance, value.members[index].after.covariance, 8e-5, 1e-18);
      compareSh(record.sh, value.members[index].after.sh);
      expect(record.opacity).toBe(before.records[index].opacity); expect(record.padding).toEqual(before.records[index].padding);
    });
    expect(masks()).toEqual(before.masks);
    const committed = command({ command: 'commitTransaction' }); expect(committed.ok, committed.error).toBe(true);
    expect(committed.alignment).toEqual(staged.alignment);
    expect(command({ command: 'beginTransaction' }).ok).toBe(true);
    expect(command({ command: 'resetAlignment', camera: value.inputCamera.state, defaultCamera: value.inputDefault.state }).ok).toBe(true);
    expect(command({ command: 'commitTransaction' }).ok).toBe(true);
    expect(records()).toEqual(before.records); expect(masks()).toEqual(before.masks);
    expect(command({ command: 'undo' }).ok).toBe(true); expect(records()).toEqual(after);
    expect(command({ command: 'redo' }).ok).toBe(true); expect(records()).toEqual(before.records);
  });
  it.each(oracle.refusals)('refuses $name normal and confirmation without changing scene or executable history', value => {
    const before = load(), camera = oracle.planeCases[0].inputCamera.state;
    expect(command({ command: 'planeNormal', points: value.points }).ok).toBe(false);
    expect(command({ command: 'summary' })).toEqual(before.summary);
    expect(command({ command: 'beginTransaction' }).ok).toBe(true);
    const rejected = command({ command: 'alignPlane', points: value.points, flip: false, camera, defaultCamera: camera });
    expect(rejected.ok).toBe(false); expect(command({ command: 'summary' }).pending).toBe(false);
    expect(command({ command: 'rollbackTransaction' }).ok).toBe(true);
    expect(records()).toEqual(before.records); expect(masks()).toEqual(before.masks);
    const summary = command({ command: 'summary' });
    expect(summary.alignment).toEqual(before.summary.alignment); expect(summary.contentRevision).toBe(before.summary.contentRevision);
    expect(summary.canUndo).toBe(before.summary.canUndo); expect(summary.canRedo).toBe(before.summary.canRedo);
  });
});
