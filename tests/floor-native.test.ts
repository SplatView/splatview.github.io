import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BUILD_DESCRIPTOR } from '../src/generated/buildIdentity';
import type { NativeSummary } from '../src/document/types';
import { validateFloorSummary, type FloorPlane } from '../src/document/floorProtocol';
import { CameraController, type CameraModule } from '../src/input/camera';
import { wasmString, type ModuleFactory, type WasmModule } from '../src/workers/wasm';

type SourceCamera = { state: number[]; view: number[]; projection: number[]; eye: number[] };
type FloorCase = { name: string; outcome: string; plane: (FloorPlane & { floatBits: number[] }) | null;
  input: { members: { positionOpacityBits: number[] }[]; states: number[]; selectedOnly: boolean;
    options: { viewpoint: number[] | null }; preCancelled: boolean };
  alignments: { yUp: boolean; uiFlip: boolean; effectiveFlip: boolean; matrix: number[];
    inputCamera: SourceCamera; worldUprightCamera: SourceCamera; afterOrbitZoom: SourceCamera;
    transformedFiniteInputPositions: number[][] }[] };
const reference = JSON.parse(readFileSync(resolve('tests/fixtures/floor-reference.json'), 'utf8')) as { floorCases: FloorCase[] };
// The public command fixes defaults and captures a real camera eye. Custom
// settings, absent viewpoints, nonfinite decoder inputs and forced pre-stop
// remain separate captured-source/linked-native contracts, not ABI coverage.
const names = ['default-horizontal', 'default-tilted-decimal', 'viewpoint-below-sign', 'all-scope-outliers',
  'selected-only-with-deleted', 'automatic-large-coordinate-magnitude', 'fewer-than-three', 'collinear-default',
  'coincident-automatic-threshold', 'all-deleted', 'all-below-opacity-threshold', 'empty-state-span-all-scope'];
const cases = names.map(name => reference.floorCases.find(value => value.name === name)!);
const alignmentCases = cases.filter(value => value.plane).flatMap(example => example.alignments.map(alignment => ({ example, alignment,
  title: `${example.name} / yUp=${alignment.yUp} / flip=${alignment.uiFlip}` })));
let core: WasmModule, camera: CameraController;
const compactUnloadedSummary = { ok: true, selectionCommitRevision: 0, undoSelectionRevision: 0, toleranceRecorded: null, toleranceRange: null, duplicateRange: null, loaded: false, kind: 0, count: 0, sourceCount: 0, memoryBytes: 0,
  exportBytes: 0, exportOutputBytes: 0,
  toleranceSessionId: null, toleranceTool: null, toleranceConnected: null, toleranceMapId: null,
  selectionMapId: null, selectionMapBytes: 0, pendingSelectionMapId: null, selectionMapRetainedIds: [], floor: null, filter: null, transformSession: null, opacitySession: null, morphologyRange: null };
function decode(pointer: number): NativeSummary {
  const value = JSON.parse(core.UTF8ToString(pointer)) as NativeSummary;
  // Raw C ABI refusals are error envelopes, not NativeSummary DTOs. The worker
  // rejects them before reading a fresh strict summary; never admit them here.
  if (!value.ok) { expect(typeof value.error).toBe('string'); return value; }
  expect(value, 'Every successful Floor-capable summary emits Floor metadata').toHaveProperty('floor');
  // The captured native DTO has a compact unloaded form, without a pending
  // field. Bind that exact form here; loaded summaries still require a bool.
  const compactUnloaded = value.loaded === false && !Object.hasOwn(value, 'pending');
  if (compactUnloaded) expect(value, 'Native DTO compact unloaded summary').toEqual(compactUnloadedSummary);
  else expect(typeof value.pending, 'Loaded native DTO pending').toBe('boolean');
  value.floor = validateFloorSummary(value.floor, { loadedCount: value.count, pending: compactUnloaded ? false : value.pending });
  return value;
}
const command = (value: unknown) => wasmString(core, JSON.stringify(value), pointer => decode(core._sv_command(pointer)));
const current = () => command({ command: 'summary' });
function finish(value: NativeSummary, work = 4096) {
  for (let step = 0; value.pending; step++) {
    expect(step, 'Small admitted Floor source must finish').toBeLessThan(1000);
    value = decode(core._sv_step(work)); expect(value.ok, value.error).toBe(true);
  }
  return value;
}
function fromBits(bits: number) { return new Float32Array(new Uint32Array([bits]).buffer)[0]; }
function ply(example: FloorCase) {
  const properties = ['x', 'y', 'z', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3',
    'opacity', 'f_dc_0', 'f_dc_1', 'f_dc_2', ...Array.from({ length: 45 }, (_, index) => `f_rest_${index}`)];
  const header = new TextEncoder().encode(['ply', 'format binary_little_endian 1.0',
    `element vertex ${example.input.members.length}`, ...properties.map(name => `property float ${name}`), 'end_header', ''].join('\n'));
  const bytes = new Uint8Array(header.length + properties.length * 4 * example.input.members.length);
  bytes.set(header); const data = new DataView(bytes.buffer); let offset = header.length;
  for (const member of example.input.members) {
    const [x, y, z, alpha] = member.positionOpacityBits.map(fromBits);
    const opacity = alpha === 1 ? 32 : alpha === 0 ? -104 : Math.log(alpha / (1 - alpha));
    // Binary RDF input inverts only source Y/Z. Positions are checked against
    // source float inputs after actual decoding, before detector comparison.
    for (const value of [x, -y, -z, -2, -2.5, -3, 1, 0, 0, 0, opacity, .1, .2, -.3,
      ...Array.from({ length: 45 }, (_, index) => (index % 7 - 3) * .03125)]) {
      data.setFloat32(offset, value, true); offset += 4;
    }
  }
  return bytes;
}
function records() {
  const count = current().count, pointer = core._sv_scene_ptr();
  return Array.from({ length: count }, (_, index) => {
    const floats = new Float32Array(core.HEAPU8.buffer, pointer + index * 144, 12).slice();
    return { position: Array.from(floats.slice(0, 3)), opacity: floats[3], covariance: Array.from(floats.slice(4, 10)),
      padding: Array.from(floats.slice(10)), sh: Array.from(new Uint32Array(core.HEAPU8.buffer, pointer + index * 144 + 48, 24)) };
  });
}
function snapshot() {
  const summary = current(), pointer = core._sv_scene_ptr(), maskPointer = core._sv_states_ptr();
  return { summary, pointer, maskPointer, words: Array.from(new Uint32Array(core.HEAPU8.buffer, pointer, summary.count * 36)),
    masks: Array.from(core.HEAPU8.slice(maskPointer, maskPointer + summary.count)) };
}
function readonly(before: ReturnType<typeof snapshot>) {
  const after = snapshot(); expect(after.words).toEqual(before.words); expect(after.masks).toEqual(before.masks);
  expect(after.pointer).toBe(before.pointer); expect(after.maskPointer).toBe(before.maskPointer);
  for (const key of ['count', 'sourceCount', 'selected', 'visible', 'revision', 'contentRevision', 'canUndo', 'canRedo',
    'alignment', 'camera', 'center', 'radius', 'yUp'] as const) expect(after.summary[key], key).toEqual(before.summary[key]);
}
function load(example = cases[1]) {
  const bytes = ply(example), pointer = core._malloc(bytes.length);
  try {
    core.HEAPU8.set(bytes, pointer);
    const result = decode(core._sv_open(pointer, bytes.length, 0, 1000, 64 * 1024 * 1024));
    expect(result.ok, result.error).toBe(true); expect(result.count).toBe(example.input.members.length); expect(result.floor).toBeNull();
  } finally { core._free(pointer); }
  const decoded = records();
  decoded.forEach((record, index) => {
    const expected = example.input.members[index].positionOpacityBits.map(fromBits);
    record.position.forEach((value, axis) => expect(value, `Decoded source XYZ ${index}/${axis}`).toBe(expected[axis]));
    expect(Math.abs(record.opacity - expected[3])).toBeLessThanOrEqual(2e-7);
    expect(record.opacity < Math.fround(1 / 255)).toBe(expected[3] < Math.fround(1 / 255));
  });
  const states = example.input.members.map((_, index) => example.input.states[index] ?? 0);
  for (const [index, state] of states.entries()) if (state & 2) {
    expect(command({ command: 'single', index, operation: 0 }).ok).toBe(true); expect(command({ command: 'delete' }).ok).toBe(true);
  }
  expect(command({ command: 'selectNone' }).ok).toBe(true);
  let operation = 0;
  for (const [index, state] of states.entries()) if ((state & 1) && !(state & 2)) {
    expect(command({ command: 'single', index, operation }).ok).toBe(true); operation = 1;
  }
  // Captured detector spans admit state3. Legal native edits retain that
  // member as deleted2; detector eligibility and source order are unchanged.
  expect(snapshot().masks).toEqual(states.map(state => state & 2 ? 2 : state & 1));
  return snapshot();
}
function detectionView(example: FloorCase) {
  const point = example.input.options.viewpoint!;
  const state = [point[0], point[1], Math.fround(point[2] - 3), 0, 0, 3, 1, 45, 1, 0, 1];
  camera.set(state); expect(Array.from(camera.eye)).toEqual(point); return camera.state;
}
function detect(example = cases[1]) {
  const value = command({ command: 'detectFloor', camera: detectionView(example) });
  expect(value.ok, value.error).toBe(true); expect(value.pending).toBe(true);
  expect(value.floor).toMatchObject({ status: 'pending', stage: 'sampling', plane: null }); return value;
}
function compare(actual: readonly number[], expected: readonly number[], relative = 2e-5, floor = 1) {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((value, index) => {
    expect(Number.isFinite(value)).toBe(true);
    expect(Math.abs(value - expected[index]), `field ${index}: ${value} vs ${expected[index]}`)
      .toBeLessThanOrEqual(relative * Math.max(floor, Math.abs(expected[index])));
  });
}
function coordinateHelper(actual: readonly number[], expected: readonly number[], input: readonly number[], matrix: readonly number[]) {
  // These captured goldens use XMVector3TransformCoord float32 intermediates;
  // Gaussian processing uses double Affine sums followed by a float cast.
  // Bound rounding/cross-target differences by operand magnitude, including
  // cancellation near Y=0. This is not an absent R0 Gaussian record golden.
  actual.forEach((value, column) => {
    const magnitude = Math.abs(matrix[12 + column]) + input.reduce((sum, coordinate, row) => sum + Math.abs(coordinate * matrix[row * 4 + column]), 0);
    expect(Number.isFinite(value)).toBe(true);
    expect(Math.abs(value - expected[column]), `DirectX coordinate helper ${column}`).toBeLessThanOrEqual(2e-5 * Math.max(1, magnitude));
  });
}
function sourcePose(actual: readonly number[], source: SourceCamera) {
  actual.forEach((value, index) => {
    const difference = value - source.state[index];
    const distance = index === 3 || index === 9 ? Math.abs(Math.atan2(Math.sin(difference), Math.cos(difference))) : Math.abs(difference);
    expect(distance).toBeLessThanOrEqual(2e-5 * Math.max(1, Math.abs(source.state[index])));
  });
  camera.set([...actual]); compare(Array.from(camera.view), source.view); compare(Array.from(camera.projection), source.projection);
  compare(Array.from(camera.eye), source.eye);
}
beforeAll(async () => {
  core = await (await import(/* @vite-ignore */ pathToFileURL(resolve('public/wasm/splatview-core.mjs')).href) as { default: ModuleFactory }).default();
  const factory = (await import(/* @vite-ignore */ pathToFileURL(resolve('public/wasm/splatview-camera.mjs')).href) as { default: ModuleFactory<CameraModule> }).default;
  camera = await CameraController.create(factory);
  expect(BUILD_DESCRIPTOR.protocolVersion).toBe(28); expect(BUILD_DESCRIPTOR.uiWorkerContract).toBe(23);
  expect(core._sv_abi_version()).toBe(24); expect(BUILD_DESCRIPTOR.native.core.abi).toBe(24);
  expect(BUILD_DESCRIPTOR.native.core.capabilities.boundedSpz3Export).toBe(1);
  expect(BUILD_DESCRIPTOR.native.core.capabilities.boundedSogExport).toBe(1);
  expect(BUILD_DESCRIPTOR.native.core.capabilities.currentViewScope).toBe(1);
  expect(BUILD_DESCRIPTOR.native.core.capabilities.transactionReceipt).toBe(2);
  expect(BUILD_DESCRIPTOR.native.core.capabilities.recoveryCheckpoint).toBe(2);
  expect(BUILD_DESCRIPTOR.native.core.capabilities.absoluteOpacitySession).toBe(1);
  expect(BUILD_DESCRIPTOR.native.core.capabilities.opacityBaseStream).toBe(1);
  expect(BUILD_DESCRIPTOR.native.core.capabilities.proTransformSession).toBe(2);
  expect(BUILD_DESCRIPTOR.native.camera.capabilities.cameraTransformGizmo).toBe(1);
  expect(BUILD_DESCRIPTOR.native.core.capabilities.alignment).toBe(4);
});
afterAll(() => camera?.dispose());

describe('actual published Floor detector against admitted captured-source fixtures', () => {
  it('emits the compact unloaded native DTO with null Floor before the first source load', () => {
    const value = current();
    expect(value).toEqual(compactUnloadedSummary); expect(value).not.toHaveProperty('pending');
    expect(core._sv_scene_ptr()).toBe(0); expect(core._sv_states_ptr()).toBe(0);
  });

  it.each(cases)('$name preserves source geometry, masks, revisions/history and matches source fit', example => {
    const before = load(example), pending = detect(example), id = pending.floor!.id;
    const partial = decode(core._sv_step(1)); expect(partial.pending).toBe(true); expect(partial.floor!.id).toBe(id); readonly(before);
    expect(command({ command: 'planeNormal', points: [[0, 0, 0], [1, 0, 0], [2, 0, 0]] }).ok).toBe(false);
    expect(current().floor!.id).toBe(id);
    const result = finish(partial); expect(result.floor!.status).toBe(example.outcome === 'candidate' ? 'ready' : 'none');
    expect(result.floor!.selectedOnly).toBe(example.input.selectedOnly); readonly(before);
    if (result.floor?.status === 'ready') {
      compare(result.floor.plane.normal, example.plane!.normal, 2e-5, 1e-8);
      compare(result.floor.plane.center, example.plane!.center, 2e-5, 1e-8);
      compare([result.floor.plane.radius, result.floor.plane.rms], [example.plane!.radius, example.plane!.rms], 2e-5, 1e-8);
      expect(result.floor.plane.inliers).toBe(example.plane!.inliers); expect(result.floor.plane.tested).toBe(example.plane!.tested);
      // Both signed-zero encodings represent the same fitted plane. Record
      // comparison uses finite f32 coordinates, not an invented bit-exact libm claim.
      expect(result.floor.plane.normal.every(value => value === Math.fround(value))).toBe(true);
    } else expect(result.floor!.plane).toBeNull();
  });
});

describe('actual published Floor confirmation and native history', () => {
  it.each(alignmentCases)('case %#: $title applies captured Floor frame/positions/camera to every member and restores exact Reset history', ({ example, alignment }) => {
    const before = load(example), ready = finish(detect(example)); expect(ready.floor?.status).toBe('ready');
    const original = records(); expect(command({ command: 'beginTransaction' }).ok).toBe(true);
    const started = command({ command: 'alignFloor', id: ready.floor!.id, flip: alignment.uiFlip,
      camera: alignment.inputCamera.state, defaultCamera: alignment.inputCamera.state });
    expect(started.ok, started.error).toBe(true); expect(started.pending).toBe(true);
    const partial = decode(core._sv_step(1)); expect(partial.pending).toBe(true);
    expect(snapshot().words).toEqual(before.words); expect(snapshot().masks).toEqual(before.masks);
    const aligned = finish(partial), after = snapshot(), transformed = records();
    expect(aligned.floor).toBeNull(); expect(aligned.alignment!.canReset).toBe(true);
    compare(aligned.alignment!.frame, alignment.matrix, 2e-5, 1e-8); expect(after.masks).toEqual(before.masks);
    const expectedDefault = [...alignment.worldUprightCamera.state]; expectedDefault[6] = aligned.radius; expectedDefault[10] = 1;
    compare(aligned.camera, expectedDefault); expect(aligned.camera[9]).toBe(0);
    transformed.forEach((record, index) => {
      coordinateHelper(record.position, alignment.transformedFiniteInputPositions[index], original[index].position, alignment.matrix);
      expect(record.opacity).toBe(original[index].opacity); expect(record.padding).toEqual(original[index].padding);
      expect(record.covariance.every(Number.isFinite)).toBe(true);
      // Orthogonal Floor rotation preserves covariance trace. These are
      // independent invariants, not absent captured Gaussian/SH record goldens.
      const trace = (values: readonly number[]) => values[0] + values[3] + values[5];
      compare([trace(record.covariance)], [trace(original[index].covariance)], 8e-5, 1e-18);
      expect(record.sh[0]).toBe(original[index].sh[0]); expect(record.sh[1] & 65535).toBe(original[index].sh[1] & 65535);
    });
    expect(command({ command: 'commitTransaction' }).ok).toBe(true);
    expect(command({ command: 'beginTransaction' }).ok).toBe(true);
    expect(command({ command: 'resetAlignment', camera: alignment.worldUprightCamera.state,
      defaultCamera: alignment.worldUprightCamera.state }).ok).toBe(true);
    expect(command({ command: 'commitTransaction' }).ok).toBe(true);
    expect(snapshot().words).toEqual(before.words); expect(snapshot().masks).toEqual(before.masks);
    expect(command({ command: 'undo' }).ok).toBe(true); expect(snapshot().words).toEqual(after.words);
    expect(command({ command: 'redo' }).ok).toBe(true); expect(snapshot().words).toEqual(before.words);
  });

  it('qualifies all 56 captured Floor frames through actual CAM4 WorldUpright and later orbit/zoom', () => {
    for (const example of reference.floorCases) for (const alignment of example.alignments) {
      const transformed = camera.transformState(alignment.inputCamera.state, alignment.matrix, 1);
      sourcePose(transformed, alignment.worldUprightCamera); expect(transformed[9]).toBe(0);
      camera.orbit(11, -7); camera.zoom(.8); sourcePose(camera.state, alignment.afterOrbitZoom);
    }
  });

  it('keeps old IDs powerless over fresh analysis/confirmation and consumes only the current candidate', () => {
    const before = load(), old = finish(detect()).floor!.id, fresh = detect(), id = fresh.floor!.id;
    expect(id).toBeGreaterThan(old); expect(command({ command: 'cancelFloor', id: old }).floor!.id).toBe(id);
    const ready = finish(current()); expect(ready.floor!.id).toBe(id);
    expect(command({ command: 'alignFloor', id: old, flip: false, camera: camera.state, defaultCamera: camera.state }).ok).toBe(false);
    readonly(before); expect(current().floor!.id).toBe(id);
    expect(command({ command: 'beginTransaction' }).ok).toBe(true);
    const started = command({ command: 'alignFloor', id, flip: false, camera: camera.state, defaultCamera: camera.state });
    expect(started.pending).toBe(true); expect(command({ command: 'cancelFloor', id: old }).pending).toBe(true);
    expect(finish(current()).floor).toBeNull(); expect(command({ command: 'commitTransaction' }).ok).toBe(true);
  });

  it.each(['cancel', 'cancelFloor'] as const)('joins partial %s confirmation and rollback restores the original candidate, masks and Redo', cancellation => {
    load(); expect(command({ command: 'alignCenter', point: [1, 0, 0], camera: camera.state, defaultCamera: camera.state }).ok).toBe(true);
    finish(current()); expect(command({ command: 'undo' }).ok).toBe(true);
    const before = snapshot(), ready = finish(detect()), id = ready.floor!.id;
    expect(before.summary.canRedo).toBe(true); expect(command({ command: 'beginTransaction' }).ok).toBe(true);
    expect(command({ command: 'alignFloor', id, flip: false, camera: camera.state, defaultCamera: camera.state }).pending).toBe(true);
    expect(decode(core._sv_step(1)).pending).toBe(true);
    expect(command(cancellation === 'cancel' ? { command: cancellation } : { command: cancellation, id }).pending).toBe(false);
    expect(command({ command: 'rollbackTransaction' }).floor).toEqual(ready.floor); readonly(before);
    expect(command({ command: 'redo' }).ok).toBe(true); expect(snapshot().words).not.toEqual(before.words);
    expect(command({ command: 'undo' }).ok).toBe(true); expect(snapshot().words).toEqual(before.words);
  });

  it('retires ready/none candidates at ordinary edit and source boundaries without granting an old ID authority', () => {
    load(); const captured = finish(detect()), before = snapshot();
    expect(command({ command: 'selectNone' }).floor).toBeNull();
    expect(command({ command: 'alignFloor', id: captured.floor!.id, flip: false, camera: camera.state, defaultCamera: camera.state }).ok).toBe(false);
    expect(snapshot().words).toEqual(before.words); expect(snapshot().masks).toEqual(before.masks);
    const line = cases.find(value => value.name === 'collinear-default')!; load(line); const none = finish(detect(line));
    expect(none.floor!.status).toBe('none');
    expect(command({ command: 'alignFloor', id: none.floor!.id, flip: false, camera: camera.state, defaultCamera: camera.state }).ok).toBe(false);
    load(); expect(current().floor).toBeNull(); expect(command({ command: 'cancelFloor', id: captured.floor!.id }).floor).toBeNull();
  });
});
