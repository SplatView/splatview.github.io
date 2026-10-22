import { admittedNativeCommand } from './fixtures/native-export';
import { beforeAll, describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { BUILD_DESCRIPTOR } from '../src/generated/buildIdentity';
import type { ModuleFactory, WasmModule } from '../src/workers/wasm';
import { wasmString } from '../src/workers/wasm';
import type { NativeSummary } from '../src/document/types';
import { gaussianPly } from './fixtures/gaussians';

let core: WasmModule;
const decode = (pointer: number) => JSON.parse(core.UTF8ToString(pointer)) as NativeSummary;
function open(bytes = gaussianPly(), format = 0, budgetBytes = 128 * 1024 * 1024) {
  const pointer = core._malloc(bytes.length);
  try { core.HEAPU8.set(bytes, pointer); return decode(core._sv_open(pointer, bytes.length, format, 1000, budgetBytes)); }
  finally { core._free(pointer); }
}
function resetBudgetFixtureOwner() {
  // Failed opens now preserve their prior owner. Establish the same small,
  // history-free owner before each tight-budget candidate so a previous test or
  // search iteration does not contribute unrelated retained allocations.
  const reset = open(gaussianPly(0)); expect(reset.ok, reset.error).toBe(true);
}
const command = (value: unknown) => wasmString(core, JSON.stringify(admittedNativeCommand(core, value)), pointer => decode(core._sv_command(pointer)));
function floats(index: number) { return new Float32Array(core.HEAPU8.buffer, core._sv_scene_ptr() + index * 144, 12).slice(); }
function shWords(index: number) { return new Uint32Array(core.HEAPU8.buffer, core._sv_scene_ptr() + index * 144 + 48, 24).slice(); }
function colorPly(dc: number[][], degree = 0) {
  const rest = 3 * ((degree + 1) ** 2 - 1);
  const properties = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2',
    ...Array.from({ length: rest }, (_, i) => `f_rest_${i}`),
    'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
  const header = ['ply', 'format ascii 1.0', `element vertex ${dc.length}`,
    ...properties.map(name => `property float ${name}`), 'end_header'].join('\n');
  const rows = dc.map(channels => [0, 0, 0, ...channels, ...Array(rest).fill(0),
    1.38629436, -2.12026354, -2.30258509, -2.52572864, 1, 0, 0, 0].join(' '));
  return new TextEncoder().encode(header + '\n' + rows.join('\n') + '\n');
}
function colorAdmissionSplat(count: number) {
  // This fixture measures post-load history admission, separately from PLY
  // header admission/decoding. Compact fixed records leave the original tight
  // budget window available for actual history + transaction allocations.
  const bytes = new Uint8Array(32 * count), view = new DataView(bytes.buffer);
  for (let index = 0; index < count; index++) {
    [.12, .1, .08].forEach((scale, axis) => view.setFloat32(32 * index + 12 + 4 * axis, scale, true));
    bytes.set([128, 128, 128, 204, 255, 128, 128, 128], 32 * index + 24);
  }
  return bytes;
}
function mask(count = 3) { return Array.from(core.HEAPU8.slice(core._sv_states_ptr(), core._sv_states_ptr() + count)); }
// Independent SH oracles use exact binary16 coefficients in native storage so
// color-selection arithmetic is tested separately from PLY axis conversion.
function halfCoefficient(index: number, coefficient: number, channel: number, binary16: number) {
  new DataView(core.HEAPU8.buffer).setUint16(core._sv_scene_ptr() + index * 144 + 48 + 2 * (3 * coefficient + channel), binary16, true);
}
const colorCamera = [0, 0, 0, 0, 0, 3, 1, 45, 1, 0, 1.6];
let toleranceId = 0;
const nextToleranceId = () => ++toleranceId;
const pickColor = (sessionId: number, tolerance: number, operation = 0, index: number | null = 0) =>
  command({ command: 'colorPick', sessionId, tolerance, operation, index, camera: colorCamera });
const adjustColor = (sessionId: number, tolerance: number) => command({ command: 'colorTolerance', sessionId, tolerance });
let mapId = 0;
function mapHeader(overrides: Record<string, number> = {}) {
  return { layoutVersion: 1, mapId: ++mapId, fullWidth: 3, fullHeight: 2, mapWidth: 3, mapHeight: 2,
    sourceCount: 3, channels: 15, ...overrides };
}
function mapPayload(header: ReturnType<typeof mapHeader>) {
  const pixels = header.mapWidth * header.mapHeight, visibleWords = Math.ceil(header.sourceCount / 32);
  const floats = pixels * (2 + (header.channels & 4 ? 3 : 0));
  const bytes = new Uint8Array(4 * (floats + (header.channels & 8 ? visibleWords : 0)));
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < pixels; i++) {
    view.setFloat32(4 * i, 3 + i / 16, true);
    view.setFloat32(4 * (pixels + i), .5, true);
    if (header.channels & 4) for (let c = 0; c < 3; c++) view.setFloat32(4 * (2 * pixels + 3 * i + c), (c + 1) / 4, true);
  }
  return bytes;
}
function mapWrite(id: number, offset: number, bytes: Uint8Array) {
  const pointer = core._malloc(Math.max(4, bytes.byteLength));
  try { core.HEAPU8.set(bytes, pointer); return decode(core._sv_map_write(id, offset, pointer, bytes.byteLength)); }
  finally { core._free(pointer); }
}
function adoptMap(header = mapHeader(), bytes = mapPayload(header)) {
  expect(command({ command: 'selectionMapBegin', ...header }).ok).toBe(true);
  for (let offset = 0; offset < bytes.byteLength; offset += 1024 * 1024)
    expect(mapWrite(header.mapId, offset, bytes.subarray(offset, offset + 1024 * 1024)).ok).toBe(true);
  const summary = command({ command: 'selectionMapCommit', mapId: header.mapId });
  expect(summary.ok, summary.error).toBe(true); return summary;
}
const volumeCamera = [0, 0, 0, 0, 0, 3, 1, 90, 1, 0, 1];
function volumeScene(points: number[][], covariance = [1e-8, 1e-8, 1e-8], budgetBytes?: number, degree = 0) {
  const summary = open(colorPly(points.map(() => [0, 0, 0]), degree), 0, budgetBytes);
  expect(summary.ok, summary.error).toBe(true);
  points.forEach((point, index) => {
    const record = new Float32Array(core.HEAPU8.buffer, core._sv_scene_ptr() + index * 144, 12);
    record.set([...point, .8, covariance[0], 0, 0, covariance[1], 0, covariance[2], 0, 0]);
  });
  return summary;
}
function volumeMap(width = 33, height = 33, depth: number | ((x: number, y: number) => number) = 3,
  visible?: number[], count = 3, opacity?: (x: number, y: number) => number) {
  const scale = Math.min(1, Math.sqrt(262144 / (width * height)));
  const header = mapHeader({ fullWidth: width, fullHeight: height,
    mapWidth: Math.max(1, Math.floor(width * scale)), mapHeight: Math.max(1, Math.floor(height * scale)),
    sourceCount: count, channels: visible ? 11 : 3 });
  const bytes = mapPayload(header), view = new DataView(bytes.buffer);
  for (let y = 0; y < header.mapHeight; y++) for (let x = 0; x < header.mapWidth; x++) {
    view.setFloat32(4 * (y * header.mapWidth + x), typeof depth === 'number' ? depth : depth(x, y), true);
    if (opacity) view.setFloat32(4 * (header.mapWidth * header.mapHeight + y * header.mapWidth + x), opacity(x, y), true);
  }
  if (visible) for (const index of visible) {
    const offset = 8 * header.mapWidth * header.mapHeight + 4 * Math.floor(index / 32);
    view.setUint32(offset, view.getUint32(offset, true) | (1 << (index % 32)), true);
  }
  adoptMap(header, bytes); return header;
}
function volumeRequest(header: ReturnType<typeof mapHeader>, extra: Record<string, unknown> = {}) {
  return { command: 'volume', mapId: header.mapId, camera: volumeCamera,
    width: header.fullWidth, height: header.fullHeight, points: [[16, 16]], radius: 1,
    operation: 0, overlap: false, visibleOnly: false, ...extra };
}
function screenScene(pixels: number[][], width = 7, height = 5, covariance?: number[], budgetBytes?: number, degree = 0) {
  return volumeScene(pixels.map(([x, y]) => [((x + .5) * 2 / width - 1) * 3 * width / height,
    (1 - (y + .5) * 2 / height) * 3, 0]), covariance, budgetBytes, degree);
}
function fillMap(opacity: (x: number, y: number) => number, visible?: number[], width = 7, height = 5, count = 3) {
  return volumeMap(width, height, 3, visible, count, opacity);
}
function fillRequest(header: ReturnType<typeof mapHeader>, sessionId: number, tolerance = .1, extra: Record<string, unknown> = {}) {
  return { command: 'fillPick', sessionId, mapId: header.mapId, camera: volumeCamera,
    width: header.fullWidth, height: header.fullHeight, seed: [1, 2], operation: 0,
    tolerance, overlap: false, visibleOnly: false, ...extra };
}
const adjustFill = (sessionId: number, tolerance: number) => command({ command: 'fillTolerance', sessionId, tolerance });
function connectedMap(rgb: (x: number, y: number) => number[], opacity: (x: number, y: number) => number,
  visible: number[], width = 23, height = 9, count = 5) {
  const scale = Math.min(1, Math.sqrt(262144 / (width * height)));
  const header = mapHeader({ fullWidth: width, fullHeight: height,
    mapWidth: Math.max(1, Math.floor(width * scale)), mapHeight: Math.max(1, Math.floor(height * scale)),
    sourceCount: count, channels: 15 });
  const bytes = mapPayload(header), view = new DataView(bytes.buffer), pixels = header.mapWidth * header.mapHeight;
  for (let y = 0; y < header.mapHeight; y++) for (let x = 0; x < header.mapWidth; x++) {
    const at = y * header.mapWidth + x;
    view.setFloat32(4 * (pixels + at), opacity(x, y), true);
    rgb(x, y).forEach((value, channel) => view.setFloat32(4 * (2 * pixels + 3 * at + channel), value, true));
  }
  for (const index of visible) {
    const offset = 20 * pixels + 4 * Math.floor(index / 32);
    view.setUint32(offset, view.getUint32(offset, true) | (1 << (index % 32)), true);
  }
  adoptMap(header, bytes); return header;
}
function connectedRequest(header: ReturnType<typeof mapHeader>, sessionId: number, tolerance = 0,
  extra: Record<string, unknown> = {}) {
  return { command: 'colorPick', sessionId, mapId: header.mapId, camera: volumeCamera,
    width: header.fullWidth, height: header.fullHeight, seed: [2, 4], index: 0, operation: 0,
    tolerance, connected: true, ...extra };
}
const toggleColor = (sessionId: number, tolerance: number, connected?: boolean, mapId?: number) =>
  command({ command: 'colorTolerance', sessionId, tolerance, connected, mapId });
function connectedFixture(budgetBytes?: number) {
  screenScene([[2, 4], [6, 4], [10, 4], [18, 4], [14, 6]], 23, 9, undefined, budgetBytes);
  halfCoefficient(2, 0, 0, 0x3c00); // A distinct contributor SH color inside the same rendered RGB patch.
  return connectedMap((x) => x >= 4 && x <= 7 ? [.375, .375, .375] : [.25, .25, .25],
    (x, y) => y === 4 && (x >= 1 && x <= 11 || x >= 17 && x <= 19) ||
      y === 5 && x === 12 || y === 6 && x >= 13 && x <= 15 ? .5 : 0, [0, 1, 2, 3, 4]);
}
function selectedExportIds(count: number) {
  const coordinates = Array.from({ length: count }, (_, index) => {
    const position = floats(index); return [position[0], -position[1], -position[2]];
  });
  const exported = command({ command: 'export', format: 2, scope: 1 });
  expect(exported.ok, exported.error).toBe(true);
  const bytes = core.HEAPU8.slice(core._sv_output_ptr(), core._sv_output_ptr() + core._sv_output_len());
  expect(bytes.byteLength % 32).toBe(0);
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: bytes.byteLength / 32 }, (_, record) => {
    const position = Array.from({ length: 3 }, (_, axis) => data.getFloat32(32 * record + 4 * axis, true));
    const index = coordinates.findIndex(source => source.every((value, axis) => value === position[axis]));
    expect(index).toBeGreaterThanOrEqual(0); return index;
  });
}
beforeAll(async () => {
  const url = pathToFileURL(resolve('public/wasm/splatview-core.mjs')).href;
  const factory = (await import(/* @vite-ignore */ url) as { default: ModuleFactory }).default;
  core = await factory();
});
describe('admitted completed Connected Color', () => {
  it('intersects contributor SH with fixed-seed rendered RGB, without crossing gaps or diagonals', () => {
    const header = connectedFixture(), id = nextToleranceId();
    const picked = command(connectedRequest(header, id));
    expect(picked.ok, picked.error).toBe(true); expect(mask(5)).toEqual([1, 0, 0, 0, 0]);
    expect(picked).toMatchObject({ toleranceTool: 'color', toleranceConnected: true, toleranceMapId: header.mapId });
    // RGB .25 -> .375 is exactly .125 in every channel. Contributor 2 has
    // different native SH despite matching the composited clicked RGB patch.
    expect(toggleColor(id, .125).ok).toBe(true); expect(mask(5)).toEqual([1, 1, 0, 0, 0]);
    toggleColor(id, 1); expect(mask(5)).toEqual([1, 1, 1, 0, 0]);
    toggleColor(id, -.1); expect(mask(5)).toEqual([1, 0, 0, 0, 0]);
    toggleColor(id, 2); expect(mask(5)).toEqual([1, 1, 1, 0, 0]);
  });
  it('compares RGB to the fixed seed rather than drifting through a neighbor gradient', () => {
    screenScene([[2, 4], [6, 4], [10, 4]], 23, 9);
    const header = connectedMap(x => Array(3).fill(x <= 3 ? .25 : x <= 7 ? .375 : .5),
      (x, y) => y === 4 && x >= 1 && x <= 11 ? .5 : 0, [0, 1, 2], 23, 9, 3);
    command(connectedRequest(header, nextToleranceId(), .125)); expect(mask()).toEqual([1, 1, 0]);
  });
  it.each([1, 4, 8])('uses only the desktop compositing-noise allowance for %i float epsilons at zero tolerance', multiples => {
    screenScene([[2, 4], [6, 4], [10, 4]], 23, 9);
    const delta = multiples * 2 ** -23;
    const header = connectedMap(x => Array(3).fill(x >= 4 && x <= 7 ? .25 + delta : .25),
      (x, y) => y === 4 && x >= 1 && x <= 11 ? .5 : 0, [0, 1, 2], 23, 9, 3);
    command(connectedRequest(header, nextToleranceId()));
    expect(mask()).toEqual(multiples <= 4 ? [1, 1, 1] : [1, 0, 0]);
  });
  it('requires opacity >=1/255 even at maximum RGB tolerance', () => {
    screenScene([[2, 4], [6, 4], [10, 4]], 23, 9);
    const header = connectedMap(() => [.25, .25, .25], (x, y) => y !== 4 || x < 1 || x > 11 ? 0 :
      x <= 3 ? 1 / 255 : x === 4 ? .99 / 255 : .5, [0, 1, 2], 23, 9, 3);
    const id = nextToleranceId(); command(connectedRequest(header, id, 1)); expect(mask()).toEqual([1, 0, 0]);
    const replacement = nextToleranceId();
    const empty = command(connectedRequest(header, replacement, 1, { seed: [4, 4] }));
    expect(empty.toleranceSessionId).toBe(replacement); expect(empty.toleranceConnected).toBe(true);
    expect(mask()).toEqual([1, 0, 0]); expect(toggleColor(id, 1).ok).toBe(false);
  });
  it('always uses global visibility and exact native touched footprints', () => {
    screenScene([[3, 2], [4.4, 2], [5.5, 2]]);
    const rgb = () => [.25, .25, .25], opacity = (x: number, y: number) => x === 3 && y === 2 ? .5 : 0;
    const map = connectedMap(rgb, opacity, [0, 1], 7, 5, 3);
    command(connectedRequest(map, nextToleranceId(), 0, { seed: [3, 2], overlap: false, visibleOnly: false }));
    expect(mask()).toEqual([1, 1, 0]); // Center 4.4 lies outside the region, but its native 3-sigma footprint touches.
    const hidden = connectedMap(rgb, opacity, [0], 7, 5, 3);
    command(connectedRequest(hidden, nextToleranceId(), 0, { seed: [3, 2] })); expect(mask()).toEqual([1, 0, 0]);
  });
  it.each([[1, 2], [2, 6], [3, 12]])('retains native SH degree %i evaluation while intersecting RGB hits', (degree, coefficient) => {
    screenScene([[11, 4], [15, 4], [18, 4]], 23, 9, undefined, undefined, degree);
    halfCoefficient(1, coefficient, 0, 0x3c00);
    const header = connectedMap(() => [.25, .25, .25], () => .5, [0, 1, 2], 23, 9, 3);
    const id = nextToleranceId(); command(connectedRequest(header, id, 0, { seed: [11, 4] })); expect(mask()).toEqual([1, 0, 1]);
    toggleColor(id, 1); expect(mask()).toEqual([1, 1, 1]);
  });
  it('maps high-DPI seeds and native footprints independently in X and Y at the floor resolution', () => {
    const width = 1025, height = 769, scale = Math.sqrt(262144 / (width * height));
    const mw = Math.floor(width * scale), mh = Math.floor(height * scale), mx = 200, my = 100;
    screenScene([[mx, my], [mx + 1, my], [mx, my + 3]].map(([x, y]) =>
      [(x + .5) * width / mw - .5, (y + .5) * height / mh - .5]), width, height);
    const header = connectedMap(() => [.25, .25, .25],
      (x, y) => y === my && (x === mx || x === mx + 1) ? .5 : 0, [0, 1, 2], width, height, 3);
    const picked = command(connectedRequest(header, nextToleranceId(), 0,
      { seed: [Math.ceil(mx * width / mw), Math.ceil(my * height / mh)] }));
    expect(picked.ok, picked.error).toBe(true); expect(mask()).toEqual([1, 1, 0]);
  });
  it.each([0, 1, 2, 3])('amends Color/Connected Combine %i once against the original baseline and one Undo', operation => {
    const header = connectedFixture(); command({ command: 'single', index: 3 });
    const id = nextToleranceId(); command(connectedRequest(header, id, 1, { operation }));
    expect(mask(5)).toEqual([[1, 1, 1, 0, 0], [1, 1, 1, 1, 0], [0, 0, 0, 1, 0], [0, 0, 0, 0, 0]][operation]);
    toggleColor(id, 1, false);
    expect(mask(5)).toEqual([[1, 1, 1, 1, 1], [1, 1, 1, 1, 1], [0, 0, 0, 0, 0], [0, 0, 0, 1, 0]][operation]);
    toggleColor(id, 0, true);
    expect(mask(5)).toEqual([[1, 0, 0, 0, 0], [1, 0, 0, 1, 0], [0, 0, 0, 1, 0], [0, 0, 0, 0, 0]][operation]);
    command({ command: 'undo' }); expect(mask(5)).toEqual(operation === 2 ? [0, 0, 0, 0, 0] : [0, 0, 0, 1, 0]);
  });
  it('preserves no-op Redo and monotonic revisions through mode growth and return to baseline', () => {
    const header = connectedFixture(); command({ command: 'single', index: 0 }); command({ command: 'single', index: 3 });
    command({ command: 'undo' }); const before = command({ command: 'summary' }), id = nextToleranceId();
    const noop = command(connectedRequest(header, id)); expect(noop.revision).toBe(before.revision); expect(noop.canRedo).toBe(true);
    const growth = toggleColor(id, 1, false); expect(growth.revision).toBeGreaterThan(noop.revision); expect(growth.canRedo).toBe(false);
    const baseline = toggleColor(id, 0, true); expect(baseline.revision).toBeGreaterThan(growth.revision); expect(mask(5)).toEqual([1, 0, 0, 0, 0]);
    expect(toggleColor(id, 0, true).revision).toBe(baseline.revision);
    toggleColor(id, 1, false); command({ command: 'undo' }); expect(mask(5)).toEqual([1, 0, 0, 0, 0]);
    command({ command: 'undo' }); expect(mask(5)).toEqual([0, 0, 0, 0, 0]);
  });
  it('captures ordinary Color click dependencies and enables Connected later without accepting replacement view/index/Combine', () => {
    const header = connectedFixture(), id = nextToleranceId();
    const ordinary = command(connectedRequest(header, id, 0, { connected: false }));
    expect(mask(5)).toEqual([1, 1, 0, 1, 1]);
    expect(ordinary).toMatchObject({ toleranceTool: 'color', toleranceConnected: false, toleranceMapId: null });
    const enabled = command({ command: 'colorTolerance', sessionId: id, tolerance: 0, connected: true, mapId: header.mapId,
      camera: colorCamera, width: 1, height: 1, seed: [0, 0], index: 2, operation: 2 });
    expect(enabled.ok, enabled.error).toBe(true); expect(mask(5)).toEqual([1, 0, 0, 0, 0]);
    expect(enabled.toleranceMapId).toBe(header.mapId);
  });
  it('keeps legacy ordinary calls valid but refuses Connected without captured view/seed', () => {
    open(); const id = nextToleranceId(), initial = pickColor(id, 1);
    expect(initial).toMatchObject({ toleranceTool: 'color', toleranceConnected: false, toleranceMapId: null });
    expect(toggleColor(id, 1, true, 1).ok).toBe(false); expect(mask()).toEqual([1, 1, 1]);
    expect(toggleColor(id, 0).ok).toBe(true); expect(command({ command: 'summary' }).toleranceConnected).toBe(false);
    const ended = command({ command: 'endTolerance', sessionId: id });
    expect(ended).toMatchObject({ toleranceTool: null, toleranceConnected: null, toleranceMapId: null });
  });
  it.each([0, 1, 2, 3])('restores the original nonempty baseline on empty Connected enable for Combine %i and retains captured operation/map', operation => {
    const header = connectedFixture();
    command({ command: 'single', index: 0 }); command({ command: 'single', index: 2, operation: 1 });
    const baseline = [1, 0, 1, 0, 0]; expect(mask(5)).toEqual(baseline);
    const id = nextToleranceId();
    const ordinary = command(connectedRequest(header, id, 0, { connected: false, operation, seed: [0, 0] }));
    const ordinaryMask = [[1, 1, 0, 1, 1], [1, 1, 1, 1, 1], [0, 0, 1, 0, 0], [1, 0, 0, 0, 0]][operation];
    expect(mask(5)).toEqual(ordinaryMask); expect(ordinary.canRedo).toBe(false);
    const retainedBytes = ordinary.selectionMapBytes;
    const empty = toggleColor(id, 1, true, header.mapId);
    expect(empty.ok, empty.error).toBe(true); expect(mask(5)).toEqual(baseline);
    expect(selectedExportIds(5)).toEqual([0, 2]);
    expect(empty.revision).toBeGreaterThan(ordinary.revision);
    expect(empty).toMatchObject({ toleranceSessionId: id, toleranceTool: 'color', toleranceConnected: true,
      toleranceMapId: header.mapId, selectionMapBytes: retainedBytes, canUndo: true, canRedo: false });
    const released = command({ command: 'selectionMapRelease', mapId: header.mapId });
    expect(released.selectionMapId).toBeNull(); expect(released.selectionMapRetainedIds).toEqual([header.mapId]);
    expect(released.selectionMapBytes).toBe(retainedBytes);
    for (const tolerance of [0, 1, .125]) {
      const repeated = toggleColor(id, tolerance, true);
      expect(repeated.revision).toBe(empty.revision); expect(repeated.toleranceConnected).toBe(true);
      expect(mask(5)).toEqual(baseline);
    }
    const off = toggleColor(id, 0, false); expect(off.ok, off.error).toBe(true);
    expect(mask(5)).toEqual(ordinaryMask);
    expect(selectedExportIds(5)).toEqual(ordinaryMask.flatMap((selected, index) => selected ? [index] : []));
    expect(off).toMatchObject({ toleranceSessionId: id, toleranceConnected: false, toleranceMapId: header.mapId });
    command({ command: 'undo' }); expect(mask(5)).toEqual(baseline);
    expect(command({ command: 'summary' }).selectionMapBytes).toBe(0);
    command({ command: 'undo' }); expect(mask(5)).toEqual([1, 0, 0, 0, 0]);
    command({ command: 'redo' }); expect(mask(5)).toEqual(baseline);
  });
  it.each([0, 1, 2, 3])('removes the originating ordinary Undo item when empty Connected Combine %i returns to baseline', operation => {
    const header = connectedFixture();
    command({ command: 'single', index: 0 }); command({ command: 'single', index: 2, operation: 1 });
    command({ command: 'single', index: 3, operation: 1 }); command({ command: 'undo' });
    expect(command({ command: 'summary' }).canRedo).toBe(true);
    const id = nextToleranceId();
    command(connectedRequest(header, id, 0, { connected: false, operation, seed: [0, 0] }));
    expect(command({ command: 'summary' }).canRedo).toBe(false);
    const empty = toggleColor(id, 0, true, header.mapId);
    expect(mask(5)).toEqual([1, 0, 1, 0, 0]); expect(empty.canRedo).toBe(false);
    // The next Undo must remove the pre-click Add of source 2, rather than
    // encounter a redundant Color amendment item that merely repeats baseline.
    command({ command: 'undo' }); expect(mask(5)).toEqual([1, 0, 0, 0, 0]);
    command({ command: 'redo' }); expect(mask(5)).toEqual([1, 0, 1, 0, 0]);
    expect(command({ command: 'redo' }).canRedo).toBe(false);
    expect(mask(5)).toEqual([1, 0, 1, 0, 0]);
  });
  it('preserves Redo for a no-op ordinary pick and empty enable, then clears it only on an actual amendment', () => {
    const header = connectedFixture();
    for (const index of [0, 1, 3, 4]) command({ command: 'single', index, operation: 1 });
    command({ command: 'single', index: 2, operation: 1 }); command({ command: 'undo' });
    const before = command({ command: 'summary' }), id = nextToleranceId();
    const ordinary = command(connectedRequest(header, id, 0, { connected: false, seed: [0, 0] }));
    expect(ordinary.revision).toBe(before.revision); expect(ordinary.canRedo).toBe(true);
    const empty = toggleColor(id, 0, true, header.mapId);
    expect(empty).toMatchObject({ revision: before.revision, canRedo: true, toleranceSessionId: id,
      toleranceConnected: true, toleranceMapId: header.mapId });
    expect(mask(5)).toEqual([1, 1, 0, 1, 1]);
    expect(toggleColor(id, 1, true).canRedo).toBe(true);
    expect(toggleColor(id, 0, false).canRedo).toBe(true);
    expect(toggleColor(id, 1, false).canRedo).toBe(false); expect(mask(5)).toEqual([1, 1, 1, 1, 1]);
    const restored = toggleColor(id, 1, true); expect(mask(5)).toEqual([1, 1, 0, 1, 1]); expect(restored.canRedo).toBe(false);
    command({ command: 'undo' }); expect(mask(5)).toEqual([1, 1, 0, 1, 0]);
  });
  it('removes the only originating Undo after empty enable on an empty baseline while retaining an adjustable owner', () => {
    const header = connectedFixture(), id = nextToleranceId();
    command(connectedRequest(header, id, 0, { connected: false, seed: [0, 0] }));
    const empty = toggleColor(id, 0, true, header.mapId);
    expect(mask(5)).toEqual([0, 0, 0, 0, 0]);
    expect(empty).toMatchObject({ canUndo: false, canRedo: false, toleranceSessionId: id,
      toleranceConnected: true, toleranceMapId: header.mapId });
    toggleColor(id, 0, false); expect(mask(5)).toEqual([1, 1, 0, 1, 1]);
    expect(command({ command: 'undo' }).canUndo).toBe(false); expect(mask(5)).toEqual([0, 0, 0, 0, 0]);
  });
  it('rolls back publication of an admitted empty enable to the preceding ordinary mask, mode and exact history', () => {
    const header = connectedFixture(); command({ command: 'single', index: 2 });
    const id = nextToleranceId(); command(connectedRequest(header, id, 0, { connected: false, operation: 1, seed: [0, 0] }));
    const before = command({ command: 'summary' }), bytes = mask(5);
    command({ command: 'beginTransaction' }); const empty = toggleColor(id, 0, true, header.mapId);
    expect(empty.ok, empty.error).toBe(true); expect(mask(5)).toEqual([0, 0, 1, 0, 0]);
    const restored = command({ command: 'rollbackTransaction' }); expect(mask(5)).toEqual(bytes);
    for (const key of ['revision', 'canUndo', 'canRedo', 'toleranceSessionId', 'toleranceConnected', 'toleranceMapId', 'selectionMapBytes'] as const)
      expect(restored[key]).toEqual(before[key]);
    command({ command: 'undo' }); expect(mask(5)).toEqual([0, 0, 1, 0, 0]);
    command({ command: 'redo' }); expect(mask(5)).toEqual(bytes);
  });
  it('rejects first-enable map admission at an empty seed without treating the refusal as an accepted baseline result', () => {
    const header = connectedFixture(); command({ command: 'single', index: 2 });
    const id = nextToleranceId(); command(connectedRequest(header, id, 0, { connected: false, operation: 1, seed: [0, 0] }));
    const ordinaryMask = [1, 1, 1, 1, 1]; expect(mask(5)).toEqual(ordinaryMask);
    const assertRefusal = (mapId: number) => {
      const before = command({ command: 'summary' });
      expect(toggleColor(id, 0, true, mapId).ok).toBe(false);
      const after = command({ command: 'summary' }); expect(mask(5)).toEqual(ordinaryMask);
      for (const key of ['revision', 'canUndo', 'canRedo', 'toleranceSessionId', 'toleranceConnected', 'toleranceMapId', 'selectionMapBytes', 'selectionMapRetainedIds', 'memoryBytes'] as const)
        expect(after[key]).toEqual(before[key]);
    };
    assertRefusal(header.mapId + 1000);
    const withoutRgb = fillMap(() => 0, [0, 1, 2, 3, 4], 23, 9, 5);
    assertRefusal(withoutRgb.mapId);
    const valid = connectedMap(() => [.25, .25, .25], () => 0, [0, 1, 2, 3, 4]);
    const accepted = toggleColor(id, 0, true, valid.mapId);
    expect(accepted.ok, accepted.error).toBe(true); expect(mask(5)).toEqual([0, 0, 1, 0, 0]);
    expect(accepted).toMatchObject({ toleranceSessionId: id, toleranceConnected: true, toleranceMapId: valid.mapId });
  });
  it('holds the first Connected map while toggled off across upgrade/release and refuses substitutions', () => {
    const original = connectedFixture(), id = nextToleranceId(); command(connectedRequest(original, id));
    const one = command({ command: 'summary' }); toggleColor(id, 0, false);
    const replacement = connectedMap(() => [.75, .75, .75], () => .5, [0, 1, 2, 3, 4]);
    const two = command({ command: 'summary' }); expect(two.selectionMapBytes).toBe(2 * one.selectionMapBytes);
    expect(two.selectionMapRetainedIds).toEqual([replacement.mapId, original.mapId]);
    expect(toggleColor(id, 0, true, replacement.mapId).ok).toBe(false);
    expect(toggleColor(id, 0, false, replacement.mapId).ok).toBe(false);
    const held = command({ command: 'selectionMapRelease', mapId: replacement.mapId });
    expect(held.selectionMapRetainedIds).toEqual([original.mapId]); expect(held.toleranceMapId).toBe(original.mapId);
    command({ command: 'selectionMapRelease', mapId: original.mapId });
    expect(toggleColor(id, 0, true).ok).toBe(true); expect(mask(5)).toEqual([1, 0, 0, 0, 0]);
    expect(command({ command: 'endTolerance', sessionId: id - 1 }).toleranceMapId).toBe(original.mapId);
    const ended = command({ command: 'endTolerance', sessionId: id }); expect(ended.selectionMapBytes).toBe(0);
  });
  it('restores connected mode, held map, exact history and owner after transaction rollback', () => {
    const header = connectedFixture(), id = nextToleranceId(); command(connectedRequest(header, id, .125));
    command({ command: 'selectionMapRelease', mapId: header.mapId }); const before = command({ command: 'summary' }), bytes = mask(5);
    command({ command: 'beginTransaction' }); toggleColor(id, 1, false); command({ command: 'endTolerance', sessionId: id });
    const replacement = nextToleranceId(); pickColor(replacement, 1);
    const restored = command({ command: 'rollbackTransaction' }); expect(mask(5)).toEqual(bytes);
    for (const key of ['revision', 'canUndo', 'canRedo', 'toleranceSessionId', 'toleranceConnected', 'toleranceMapId', 'selectionMapBytes', 'selectionMapRetainedIds'] as const)
      expect(restored[key]).toEqual(before[key]);
    expect(pickColor(replacement, 1).ok).toBe(false); expect(toggleColor(id, 0).ok).toBe(true);
    command({ command: 'beginTransaction' }); toggleColor(id, 0, false); command({ command: 'commitTransaction' });
    expect(command({ command: 'summary' }).toleranceMapId).toBe(header.mapId);
  });
  it('rolls back first enable to the original ordinary mode without retaining a hidden map lease', () => {
    const header = connectedFixture(), id = nextToleranceId(); command(connectedRequest(header, id, 0, { connected: false }));
    const before = command({ command: 'summary' }), bytes = mask(5); command({ command: 'beginTransaction' });
    toggleColor(id, 0, true, header.mapId); command({ command: 'selectionMapRelease', mapId: header.mapId });
    const restored = command({ command: 'rollbackTransaction' }); expect(mask(5)).toEqual(bytes);
    expect(restored).toMatchObject({ toleranceConnected: false, toleranceMapId: null, revision: before.revision });
    expect(command({ command: 'selectionMapRelease', mapId: header.mapId }).selectionMapBytes).toBe(0);
  });
  it('preserves the preceding Fill owner for missing contributors or invalid Connected replacement calls', () => {
    screenScene([[1, 2], [2, 2], [3, 2]]); const fill = fillMap((x, y) => x === 1 && y === 2 ? .5 : 0);
    const id = nextToleranceId(), initial = command(fillRequest(fill, id, 0));
    expect(initial).toMatchObject({ toleranceTool: 'fill', toleranceConnected: null, toleranceMapId: fill.mapId });
    const rgb = connectedMap(() => [.25, .25, .25], (x, y) => x === 1 && y === 2 ? .5 : 0, [0, 1, 2], 7, 5, 3);
    for (const extra of [{ index: null }, { index: 99 }, { seed: [-1, 0] }, { seed: [7, 0] }]) {
      const empty = command(connectedRequest(rgb, nextToleranceId(), 1, extra)); expect(empty.ok).toBe(true);
      expect(empty.toleranceSessionId).toBe(id); expect(empty.toleranceTool).toBe('fill'); expect(mask()).toEqual([1, 0, 0]);
    }
    const before = command({ command: 'summary' });
    for (const extra of [{ width: 8 }, { seed: [1.5, 2] }, { camera: volumeCamera.toSpliced(5, 1, 0) }, { connected: 1 }]) {
      expect(command(connectedRequest(rgb, nextToleranceId(), 1, extra)).ok).toBe(false);
      const after = command({ command: 'summary' }); expect(after.toleranceSessionId).toBe(id); expect(after.revision).toBe(before.revision);
    }
    expect(toggleColor(id, 1, true, rgb.mapId).ok).toBe(false); expect(adjustFill(id, 0).ok).toBe(true);
  });
  it.each([0, 1, 2, 3])('captures a new no-op Connected owner at a transparent mapped seed and later applies Combine %i from the new baseline', operation => {
    connectedFixture();
    command({ command: 'single', index: 0 }); command({ command: 'single', index: 2, operation: 1 });
    command({ command: 'single', index: 3, operation: 1 }); command({ command: 'undo' });
    const baseline = [1, 0, 1, 0, 0]; expect(mask(5)).toEqual(baseline);
    const fill = fillMap((x, y) => y === 4 && x >= 1 && x <= 11 ? .5 : 0, [0, 2], 23, 9, 5);
    const previousId = nextToleranceId();
    const previous = command(fillRequest(fill, previousId, 0, { seed: [2, 4], visibleOnly: true, overlap: true }));
    expect(previous.ok, previous.error).toBe(true); expect(mask(5)).toEqual(baseline); expect(previous.canRedo).toBe(true);
    const rgb = connectedMap(() => [.25, .25, .25], () => 0, [0, 1, 2, 3, 4]);
    const before = command({ command: 'summary' }), replacementId = nextToleranceId();
    expect(before.selectionMapRetainedIds).toEqual([rgb.mapId, fill.mapId]);
    const replacement = command(connectedRequest(rgb, replacementId, 1, { operation }));
    expect(replacement.ok, replacement.error).toBe(true); expect(mask(5)).toEqual(baseline);
    expect(selectedExportIds(5)).toEqual([0, 2]);
    expect(replacement).toMatchObject({ revision: before.revision, canUndo: before.canUndo, canRedo: true,
      toleranceSessionId: replacementId, toleranceTool: 'color', toleranceConnected: true, toleranceMapId: rgb.mapId });
    expect(replacement.selectionMapRetainedIds).toEqual([rgb.mapId]);
    expect(replacement.selectionMapBytes).toBe(Number(before.selectionMapBytes) - Number(previous.selectionMapBytes));
    expect(adjustFill(previousId, 1).ok).toBe(false);
    const staleEnd = command({ command: 'endTolerance', sessionId: previousId });
    expect(staleEnd.toleranceSessionId).toBe(replacementId);
    const released = command({ command: 'selectionMapRelease', mapId: rgb.mapId });
    expect(released.selectionMapRetainedIds).toEqual([rgb.mapId]);
    expect(released.selectionMapBytes).toBe(replacement.selectionMapBytes);
    const repeated = toggleColor(replacementId, 0, true); expect(repeated.revision).toBe(before.revision);
    expect(repeated.canRedo).toBe(true); expect(mask(5)).toEqual(baseline);
    const off = toggleColor(replacementId, 0, false);
    const expected = [[1, 1, 0, 1, 1], [1, 1, 1, 1, 1], [0, 0, 1, 0, 0], [1, 0, 0, 0, 0]][operation];
    expect(off.ok, off.error).toBe(true); expect(mask(5)).toEqual(expected); expect(off.canRedo).toBe(false);
    expect(selectedExportIds(5)).toEqual(expected.flatMap((selected, index) => selected ? [index] : []));
    expect(off).toMatchObject({ toleranceSessionId: replacementId, toleranceConnected: false, toleranceMapId: rgb.mapId });
    command({ command: 'undo' }); expect(mask(5)).toEqual(baseline);
    expect(command({ command: 'summary' }).selectionMapBytes).toBe(0);
    command({ command: 'undo' }); expect(mask(5)).toEqual([1, 0, 0, 0, 0]);
    command({ command: 'undo' }); expect(mask(5)).toEqual([0, 0, 0, 0, 0]);
  });
  it('replaces a changing ordinary Color owner with a transparent Connected pick whose later ordinary amendment uses its own checkpoint', () => {
    const header = connectedFixture(); command({ command: 'single', index: 0 });
    const previousId = nextToleranceId();
    command(connectedRequest(header, previousId, 0, { connected: false, index: 2, operation: 1 }));
    expect(mask(5)).toEqual([1, 0, 1, 0, 0]);
    const transparent = connectedMap(() => [.25, .25, .25], () => 0, [0, 1, 2, 3, 4]);
    const before = command({ command: 'summary' }), replacementId = nextToleranceId();
    const replacement = command(connectedRequest(transparent, replacementId, 0, { operation: 1 }));
    expect(replacement).toMatchObject({ revision: before.revision, canUndo: true, canRedo: false,
      toleranceSessionId: replacementId, toleranceConnected: true, toleranceMapId: transparent.mapId });
    expect(mask(5)).toEqual([1, 0, 1, 0, 0]); expect(toggleColor(previousId, 1, false).ok).toBe(false);
    expect(command({ command: 'endTolerance', sessionId: previousId }).toleranceSessionId).toBe(replacementId);
    toggleColor(replacementId, 0, false); expect(mask(5)).toEqual([1, 1, 1, 1, 1]);
    command({ command: 'undo' }); expect(mask(5)).toEqual([1, 0, 1, 0, 0]);
    command({ command: 'undo' }); expect(mask(5)).toEqual([1, 0, 0, 0, 0]);
    command({ command: 'redo' }); expect(mask(5)).toEqual([1, 0, 1, 0, 0]);
  });
  it('rejects maps missing RGB/visibility and incomplete ordinary capture without altering the current owner', () => {
    screenScene([[1, 2], [2, 2], [3, 2]]); const id = nextToleranceId(); pickColor(id, 0);
    for (const visible of [undefined, [0, 1, 2]]) {
      const header = fillMap(() => .5, visible);
      const before = command({ command: 'summary' });
      expect(command(connectedRequest(header, nextToleranceId(), 1, { seed: [1, 2] })).ok).toBe(false);
      expect(command({ command: 'summary' }).revision).toBe(before.revision);
      expect(command({ command: 'summary' }).toleranceSessionId).toBe(id);
    }
    for (const extra of [{ width: 7 }, { width: 0, height: 5, seed: [1, 2] }, { width: 7, height: 5, seed: [1] }])
      expect(command({ command: 'colorPick', sessionId: nextToleranceId(), tolerance: 0, index: 0, camera: volumeCamera, ...extra }).ok).toBe(false);
    expect(command({ command: 'summary' }).toleranceSessionId).toBe(id);
  });
  it.each(['undo', 'draft', 'delete'])('invalidates Connected owner and releases the held map after unrelated %s', mutation => {
    const header = connectedFixture(), id = nextToleranceId(); command(connectedRequest(header, id));
    command({ command: 'selectionMapRelease', mapId: header.mapId });
    command({ command: mutation === 'draft' ? 'beginSelection' : mutation });
    const summary = command({ command: 'summary' }); expect(summary.toleranceSessionId).toBeNull(); expect(summary.toleranceMapId).toBeNull();
    expect(summary.selectionMapRetainedIds).toEqual([]); expect(summary.selectionMapBytes).toBe(0);
    expect(toggleColor(id, 1, true).ok).toBe(false);
  });
  it('refuses first-enable scratch atomically without changing ordinary mode, history or map ownership', () => {
    screenScene([[1, 2], [2, 2], [3, 2]], 7, 5, undefined, 128 * 1024);
    const large = connectedMap(() => [.25, .25, .25], () => .5, [0, 1, 2], 128, 40, 3), id = nextToleranceId();
    command(connectedRequest(large, id, 0, { connected: false, seed: [1, 2] }));
    const before = command({ command: 'summary' }), bytes = mask();
    const refused = toggleColor(id, 1, true, large.mapId); expect(refused.ok).toBe(false); expect(refused.error).toMatch(/resource|budget|limit/i);
    const after = command({ command: 'summary' }); expect(mask()).toEqual(bytes);
    for (const key of ['revision', 'canUndo', 'canRedo', 'toleranceSessionId', 'toleranceConnected', 'toleranceMapId', 'selectionMapBytes', 'memoryBytes'] as const)
      expect(after[key]).toEqual(before[key]);
    expect(toggleColor(id, 0, false).ok).toBe(true);
  });
  it('preserves a Connected amendment under retained-map pressure and succeeds after active-map release', () => {
    screenScene([[1, 2], [2, 2], [3, 2]], 7, 5, undefined, 192 * 1024);
    const original = connectedMap(() => [.25, .25, .25], () => .5, [0, 1, 2], 128, 48, 3), id = nextToleranceId();
    const picked = command(connectedRequest(original, id, 0, { seed: [1, 2] })); expect(picked.ok, picked.error).toBe(true);
    const active = connectedMap(() => [.25, .25, .25], () => .5, [0, 1, 2], 100, 30, 3);
    const before = command({ command: 'summary' }), bytes = mask();
    const refused = toggleColor(id, 1, true); expect(refused.ok).toBe(false); expect(refused.error).toMatch(/resource|budget|limit/i);
    const after = command({ command: 'summary' }); expect(mask()).toEqual(bytes);
    for (const key of ['revision', 'canUndo', 'canRedo', 'toleranceSessionId', 'toleranceConnected', 'toleranceMapId', 'selectionMapBytes', 'memoryBytes'] as const)
      expect(after[key]).toEqual(before[key]);
    command({ command: 'selectionMapRelease', mapId: active.mapId }); expect(toggleColor(id, 1, true).ok).toBe(true);
  });
});
describe('desktop C++ compiled to real WASM', () => {
  it('uses normalized RGB distance and clamps color and domain tolerance like desktop Color picker', () => {
    open(colorPly([[0, 0, 0], [.5, 0, 0], [.5, .5, .5]]));
    const request = { command: 'color', camera: colorCamera, index: 0, operation: 0 };
    // The second point differs by .1410474 in one channel: RMS .08143375.
    command({ ...request, tolerance: .08 }); expect(mask()).toEqual([1, 0, 0]);
    command({ ...request, tolerance: .09 }); expect(mask()).toEqual([1, 1, 0]);
    command({ ...request, tolerance: .15 }); expect(mask()).toEqual([1, 1, 1]);
    command({ ...request, tolerance: -1 }); expect(mask()).toEqual([1, 0, 0]);
    command({ ...request, tolerance: 2 }); expect(mask()).toEqual([1, 1, 1]);
    open(colorPly([[2, 0, -2], [8, 0, -8], [0, 0, 0]]));
    command({ ...request, tolerance: 0 }); expect(mask()).toEqual([1, 1, 0]);
    expect(command({ command: 'summary' }).contentRevision).toBe(0);
  });
  it.each([0, 1, 2, 3])('matches an independent axial SH%i numerical boundary, including zero-length eye fallback', degree => {
    open(colorPly([[0, 0, 0], [0, 0, 0], [0, 0, 0]], degree));
    halfCoefficient(1, [0, 2, 6, 12][degree], 0, 0x3400); // exactly .25
    if (degree < 3) halfCoefficient(2, (degree + 1) * (degree + 2), 0, 0x3800); // undeclared axial higher band is ignored
    // At +Z the m=0 real SH basis is sqrt((2*l+1)/(4*pi)).
    const difference = .25 * Math.sqrt((2 * degree + 1) / (4 * Math.PI));
    const boundary = difference / Math.sqrt(3);
    const request = { command: 'color', camera: [...colorCamera.slice(0, 5), 0, ...colorCamera.slice(6)], index: 0, operation: 0 };
    expect(command({ ...request, tolerance: boundary - 1e-6 }).ok).toBe(true);
    expect(mask()).toEqual([1, 0, 1]);
    command({ ...request, tolerance: boundary + 1e-6 }); expect(mask()).toEqual([1, 1, 1]);
  });
  it('matches all 16 real SH terms against a Legendre/trigonometric oracle', () => {
    open(colorPly([[-.5, 0, 0], ...Array.from({ length: 16 }, () => [0, 0, 0])], 3));
    for (let coefficient = 0; coefficient < 16; coefficient++) halfCoefficient(coefficient + 1, coefficient, 0, 0x3400);
    // This oracle uses associated Legendre recurrence, rather than copying the
    // native Cartesian polynomials. An offset seed distinguishes SH signs.
    const z = 3 / Math.sqrt(14), phi = Math.atan2(2, 1);
    const factorial = (n: number): number => n <= 1 ? 1 : n * factorial(n - 1);
    const spherical = (l: number, signedM: number) => {
      const m = Math.abs(signedM);
      let previous = 1;
      for (let k = 1; k <= m; k++) previous *= -(2 * k - 1) * Math.sqrt(1 - z * z);
      let value = previous;
      if (l > m) value = (2 * m + 1) * z * previous;
      for (let k = m + 2; k <= l; k++) {
        const next = ((2 * k - 1) * z * value - (k + m - 1) * previous) / (k - m);
        previous = value; value = next;
      }
      const normalization = Math.sqrt((2 * l + 1) / (4 * Math.PI) * factorial(l - m) / factorial(l + m));
      return normalization * value * (m ? Math.SQRT2 * (signedM < 0 ? Math.sin(m * phi) : Math.cos(m * phi)) : 1);
    };
    const request = { command: 'color', camera: [-1, -2, -3, 0, 0, 0, 1, 45, 1, 0, 1.6], index: 0, operation: 0 };
    for (let l = 0; l <= 3; l++) for (let m = -l; m <= l; m++) {
      const index = l * l + l + m + 1;
      const boundary = Math.abs(.25 * spherical(l, m) + .5 / Math.sqrt(4 * Math.PI)) / Math.sqrt(3);
      command({ ...request, tolerance: boundary - 1e-6 }); expect(mask(17)[index], `SH(${l},${m}) below`).toBe(0);
      command({ ...request, tolerance: boundary + 1e-6 }); expect(mask(17)[index], `SH(${l},${m}) above`).toBe(1);
    }
  });
  it('evaluates directional color from the current eye separately for each Gaussian', () => {
    open(colorPly([[0, 0, 0], [.5, 0, 0], [-.5, 0, 0]], 1));
    halfCoefficient(1, 2, 0, 0x3800); halfCoefficient(2, 2, 0, 0x3800); // exactly .5
    const request = { command: 'color', index: 0, tolerance: .1, operation: 0 };
    command({ ...request, camera: colorCamera }); expect(mask()).toEqual([1, 1, 0]); // eye +Z
    command({ ...request, camera: [...colorCamera.slice(0, 8), 0, ...colorCamera.slice(9)] });
    expect(mask()).toEqual([1, 0, 1]); // eye -Z
    const scene = new DataView(core.HEAPU8.buffer);
    scene.setFloat32(core._sv_scene_ptr() + 144 + 8, -1, true);
    scene.setFloat32(core._sv_scene_ptr() + 288 + 8, 1, true);
    command({ ...request, camera: [...colorCamera.slice(0, 5), 0, ...colorCamera.slice(6)] });
    expect(mask()).toEqual([1, 1, 1]);
  });
  it.each([0, 1, 2, 3])('decreasing Color tolerance uses the original Combine %i baseline and creates one history entry', operation => {
    open(colorPly([[0, 0, 0], [.5, 0, 0], [1, 0, 0]]));
    command({ command: 'single', index: 1 }); command({ command: 'beginSelection' });
    const request = { command: 'color', camera: colorCamera, index: 0, operation, fromBaseline: true };
    expect(command({ ...request, tolerance: 1 }).selected).toBe([3, 3, 0, 1][operation]);
    expect(command({ ...request, tolerance: 0 }).selected).toBe([1, 2, 1, 0][operation]);
    expect(command({ command: 'confirmSelection' }).contentRevision).toBe(0);
    if (operation === 2) { expect(command({ command: 'undo' }).selected).toBe(0); return; }
    expect(command({ command: 'undo' }).selected).toBe(1); expect(mask()).toEqual([0, 1, 0]);
    expect(command({ command: 'undo' }).selected).toBe(0);
  });
  it('preserves selection/history for empty or deleted Color seeds and excludes deleted candidates', () => {
    open(colorPly([[0, 0, 0], [.5, 0, 0], [1, 0, 0]])); command({ command: 'single', index: 1 });
    const before = command({ command: 'summary' });
    const request = { command: 'color', camera: colorCamera, tolerance: 1, operation: 0 };
    for (const index of [null, 999]) {
      const result = command({ ...request, index });
      expect(result.ok).toBe(true); expect(result.revision).toBe(before.revision); expect(mask()).toEqual([0, 1, 0]);
    }
    command({ command: 'delete' }); const deleted = command({ command: 'summary' });
    expect(command({ ...request, index: 1 }).revision).toBe(deleted.revision); expect(mask()).toEqual([0, 2, 0]);
    expect(command({ ...request, index: 0 }).selected).toBe(2); expect(mask()).toEqual([1, 2, 1]);
    expect(command({ command: 'undo' }).selected).toBe(0); expect(mask()).toEqual([0, 2, 0]);
  });
  it('restores an absolute empty Color update to its baseline, and cancel keeps the redo stack', () => {
    open(colorPly([[0, 0, 0], [.5, 0, 0], [1, 0, 0]]));
    command({ command: 'single', index: 1 }); command({ command: 'delete' }); command({ command: 'undo' });
    command({ command: 'beginSelection' });
    const request = { command: 'color', camera: colorCamera, tolerance: 1, operation: 0, fromBaseline: true };
    expect(command({ ...request, index: 0 }).selected).toBe(3);
    const empty = command({ ...request, index: null }); expect(empty.selected).toBe(1); expect(empty.selectionDraft).toBe(true);
    expect(empty.canRedo).toBe(true); expect(mask()).toEqual([0, 1, 0]);
    command({ ...request, index: 0 }); const canceled = command({ command: 'cancelSelection' });
    expect(canceled.selected).toBe(1); expect(canceled.canRedo).toBe(true); expect(canceled.contentRevision).toBe(0);
    expect(command({ command: 'redo' }).visible).toBe(2);
  });
  it.each([0, 1, 2, 3])('amends one completed Color click from its original Combine %i baseline', operation => {
    open(colorPly([[0, 0, 0], [.5, 0, 0], [1, 0, 0]]));
    command({ command: 'single', index: 1 }); const id = nextToleranceId();
    const first = pickColor(id, 1, operation);
    expect(first.ok).toBe(true); expect(first.selectionDraft).toBe(false); expect(first.toleranceSessionId).toBe(id);
    expect(mask()).toEqual([[1, 1, 1], [1, 1, 1], [0, 0, 0], [0, 1, 0]][operation]);
    const smaller = adjustColor(id, 0);
    const expected = [[1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 0]][operation];
    expect(mask()).toEqual(expected); expect(smaller.revision).toBeGreaterThan(first.revision);
    expect(smaller.contentRevision).toBe(0); expect(smaller.toleranceSessionId).toBe(id);
    expect(adjustColor(id, 0).revision).toBe(smaller.revision);
    adjustColor(id, 1); adjustColor(id, 0); expect(mask()).toEqual(expected);
    const undo = command({ command: 'undo' }); expect(undo.toleranceSessionId).toBeNull();
    if (operation === 2) {
      // Returning to the original mask removes the Color entry completely.
      expect(mask()).toEqual([0, 0, 0]); expect(undo.canUndo).toBe(false);
      command({ command: 'redo' }); expect(mask()).toEqual([0, 1, 0]);
    } else {
      expect(mask()).toEqual([0, 1, 0]);
      command({ command: 'redo' }); expect(mask()).toEqual(expected);
      command({ command: 'undo' }); expect(command({ command: 'undo' }).canUndo).toBe(false);
      expect(mask()).toEqual([0, 0, 0]);
    }
  });
  it('keeps Redo on an initial Color no-op, then removes the one amended entry on return to baseline', () => {
    open(colorPly([[0, 0, 0], [.5, 0, 0], [1, 0, 0]]));
    command({ command: 'single', index: 1 }); command({ command: 'delete' }); command({ command: 'undo' });
    const before = command({ command: 'summary' }), id = nextToleranceId();
    const initial = pickColor(id, 0, 1, 1);
    expect(initial.revision).toBe(before.revision); expect(initial.canRedo).toBe(true);
    expect(initial.toleranceSessionId).toBe(id); expect(mask()).toEqual([0, 1, 0]);
    const changed = adjustColor(id, 1); expect(mask()).toEqual([1, 1, 1]);
    expect(changed.canRedo).toBe(false); expect(changed.revision).toBe(before.revision + 1);
    const baseline = adjustColor(id, 0); expect(mask()).toEqual([0, 1, 0]);
    expect(baseline.revision).toBe(changed.revision + 1); expect(baseline.canRedo).toBe(false);
    expect(adjustColor(id, 0).revision).toBe(baseline.revision);
    adjustColor(id, 1); expect(command({ command: 'undo' }).selected).toBe(1);
    expect(command({ command: 'undo' }).selected).toBe(0);
  });
  it('keeps a valid no-op checkpoint without history and captures camera, seed and Combine for later updates', () => {
    open(colorPly([[0, 0, 0], [.5, 0, 0], [-.5, 0, 0]], 1));
    const emptyId = nextToleranceId();
    expect(pickColor(emptyId, 1, 3).canUndo).toBe(false); // Intersect with an empty mask.
    expect(adjustColor(emptyId, 0).revision).toBe(0);
    halfCoefficient(1, 2, 0, 0x3800); halfCoefficient(2, 2, 0, 0x3800);
    const id = nextToleranceId(); expect(pickColor(id, 1).selected).toBe(3);
    const result = command({ command: 'colorTolerance', sessionId: id, tolerance: .1,
      index: 2, operation: 2, camera: [...colorCamera.slice(0, 8), 0, ...colorCamera.slice(9)] });
    expect(result.ok).toBe(true); expect(mask()).toEqual([1, 1, 0]);
  });
  it('preserves an existing Color owner on empty/deleted seeds and ignores an old end message', () => {
    open(colorPly([[0, 0, 0], [.5, 0, 0], [1, 0, 0]]));
    command({ command: 'single', index: 2 }); command({ command: 'delete' });
    const id = nextToleranceId(); const initial = pickColor(id, 1);
    expect(mask()).toEqual([1, 1, 2]);
    for (const index of [null, 999, 2]) {
      const attemptedId = nextToleranceId(), invalid = pickColor(attemptedId, 0, 0, index);
      expect(invalid.toleranceSessionId).toBe(id); expect(invalid.revision).toBe(initial.revision);
      expect(pickColor(attemptedId, 0).ok).toBe(false);
      expect(command({ command: 'endTolerance', sessionId: attemptedId }).toleranceSessionId).toBe(id);
    }
    expect(adjustColor(id, 0).selected).toBe(1); expect(mask()).toEqual([1, 0, 2]);
    const nextId = nextToleranceId(); pickColor(nextId, 1);
    expect(command({ command: 'endTolerance', sessionId: id }).toleranceSessionId).toBe(nextId);
    const before = command({ command: 'summary' });
    const ended = command({ command: 'endTolerance', sessionId: nextId });
    expect(ended.toleranceSessionId).toBeNull(); expect(ended.revision).toBe(before.revision);
    expect(adjustColor(nextId, 0).ok).toBe(false);
  });
  it.each(['undo', 'redo', 'single', 'delete', 'transform', 'draft', 'open'])('rejects a stale Color checkpoint after %s', mutation => {
    const bytes = colorPly([[0, 0, 0], [.5, 0, 0], [1, 0, 0]]);
    open(bytes); const id = nextToleranceId(); pickColor(id, 1);
    if (mutation === 'redo') command({ command: 'undo' });
    if (mutation === 'transform') {
      command({ command: 'transform', matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 1] });
      decode(core._sv_step(100));
    } else if (mutation === 'open') open(bytes);
    else if (mutation === 'draft') command({ command: 'beginSelection' });
    else command({ command: mutation, index: 1 });
    const before = command({ command: 'summary' }), states = mask();
    expect(before.toleranceSessionId).toBeNull(); expect(adjustColor(id, 0).ok).toBe(false);
    const after = command({ command: 'summary' });
    expect(after.revision).toBe(before.revision); expect(after.contentRevision).toBe(before.contentRevision);
    expect(after.canUndo).toBe(before.canUndo); expect(after.canRedo).toBe(before.canRedo); expect(mask()).toEqual(states);
    expect(pickColor(id, 0).ok).toBe(false); // Opening/Undo never recycles IDs.
  });
  it('releases an invalidated admitted Color baseline immediately, including draft-only invalidation', () => {
    open(); const id = nextToleranceId(); pickColor(id, 1);
    const before = command({ command: 'summary' });
    const draft = command({ command: 'beginSelection' });
    expect(draft.toleranceSessionId).toBeNull();
    expect(draft.memoryBytes).toBe(before.memoryBytes - 3); // Original pre-click mask is no longer held.
    expect(command({ command: 'endTolerance', sessionId: id }).memoryBytes).toBe(draft.memoryBytes);
    command({ command: 'cancelSelection' }); expect(adjustColor(id, 0).ok).toBe(false);
  });
  it('restores the exact amended Color checkpoint on transaction rollback and never reuses attempted IDs', () => {
    open(colorPly([[0, 0, 0], [.5, 0, 0], [1, 0, 0]])); command({ command: 'single', index: 1 });
    const id = nextToleranceId(); pickColor(id, 1, 1, 1);
    const before = command({ command: 'summary' }), states = mask();
    command({ command: 'beginTransaction' }); adjustColor(id, 0);
    const attemptedId = nextToleranceId(); pickColor(attemptedId, 0);
    expect(command({ command: 'summary' }).toleranceSessionId).toBe(attemptedId);
    const restored = command({ command: 'rollbackTransaction' });
    expect(restored.toleranceSessionId).toBe(id); expect(mask()).toEqual(states);
    expect(restored.revision).toBe(before.revision); expect(restored.canUndo).toBe(before.canUndo);
    expect(restored.canRedo).toBe(before.canRedo); expect(restored.memoryBytes).toBe(before.memoryBytes);
    expect(pickColor(attemptedId, 0).ok).toBe(false);
    const baseline = adjustColor(id, 0); expect(mask()).toEqual([0, 1, 0]);
    expect(baseline.revision).toBe(before.revision + 1); // Original checkpoint revision was restored.
    command({ command: 'beginTransaction' }); adjustColor(id, 1); command({ command: 'commitTransaction' });
    expect(adjustColor(id, 0).toleranceSessionId).toBe(id);
    expect(command({ command: 'undo' }).selected).toBe(0); // Color entry was removed, leaving the earlier Single.
  });
  it('rejects malformed Color session IDs without replacing the current owner', () => {
    open(); const id = nextToleranceId(); pickColor(id, 0);
    const before = command({ command: 'summary' });
    for (const invalid of [0, -1, .5, 9007199254740992, '1', null]) {
      expect(command({ command: 'colorPick', sessionId: invalid, tolerance: 1, index: 0, camera: colorCamera }).ok).toBe(false);
      expect(command({ command: 'summary' }).toleranceSessionId).toBe(id);
    }
    expect(command({ command: 'summary' }).revision).toBe(before.revision);
  });
  it.each([0, .1])('preserves mask, history and Color owner after initial tolerance %f when admitted staging is refused', initialTolerance => {
    const count = 1000, bytes = colorAdmissionSplat(count);
    let observedHistoryRefusal = false;
    // Search a bounded range of real budgets rather than injecting a failure
    // into the production ABI. Ten retained entries + transaction copy create
    // enough admitted history pressure to refuse an actual amendment delta.
    for (let budgetBytes = 256 * 1024; budgetBytes <= 384 * 1024; budgetBytes += 1024) {
      resetBudgetFixtureOwner();
      if (!open(bytes, 1, budgetBytes).ok) continue;
      for (let index = 0; index < count; index++) {
        // Same exact SH0 colors {0,.5,1} as the original domain fixture; this
        // existing native fixture seam excludes source RGB quantization.
        halfCoefficient(index, 0, 0, [0, 0x3800, 0x3c00][index % 3]);
        halfCoefficient(index, 0, 1, 0); halfCoefficient(index, 0, 2, 0);
      }
      let ready = true;
      for (let i = 0; i < 10; i++) {
        if (!command({ command: i % 2 ? 'selectNone' : 'selectAll' }).ok) { ready = false; break; }
      }
      if (!ready || !command({ command: 'color', index: 0, camera: colorCamera, operation: 0, tolerance: 0 }).ok) continue;
      const id = nextToleranceId(); if (!pickColor(id, initialTolerance, 1).ok) continue;
      const original = command({ command: 'summary' }), states = mask(count);
      if (!command({ command: 'beginTransaction' }).ok) continue;
      const before = command({ command: 'summary' });
      if (budgetBytes - before.memoryBytes < count) continue; // Work mask itself must fit.
      const result = adjustColor(id, 1);
      if (result.ok) continue;
      expect(result.error).toMatch(/resource byte limit exceeded/i);
      const refused = command({ command: 'summary' });
      expect(refused.revision).toBe(before.revision); expect(refused.memoryBytes).toBe(before.memoryBytes);
      expect(refused.canUndo).toBe(before.canUndo); expect(refused.canRedo).toBe(before.canRedo);
      expect(refused.toleranceSessionId).toBe(id); expect(mask(count)).toEqual(states);
      const failedId = nextToleranceId(); expect(pickColor(failedId, 0, 0, 2).ok).toBe(false);
      expect(command({ command: 'summary' }).toleranceSessionId).toBe(id);
      expect(command({ command: 'summary' }).memoryBytes).toBe(before.memoryBytes);
      const rollback = command({ command: 'rollbackTransaction' });
      expect(rollback.revision).toBe(original.revision);
      // Native history copies may shed unused vector capacity on rollback.
      expect(rollback.memoryBytes).toBeLessThanOrEqual(original.memoryBytes);
      expect(rollback.toleranceSessionId).toBe(id); expect(mask(count)).toEqual(states);
      expect(pickColor(failedId, 0).ok).toBe(false); expect(adjustColor(id, 0).ok).toBe(true);
      expect(command({ command: 'undo' }).selected).toBe(0);
      expect(command({ command: 'redo' }).selected).toBe(334);
      observedHistoryRefusal = true; break;
    }
    expect(observedHistoryRefusal).toBe(true);
  });
  it('queries current focus coordinates without editing selection or history', () => {
    open();
    const before = command({ command: 'summary' });
    const initial = command({ command: 'point', index: 1 });
    expect(initial.point?.[0]).toBeCloseTo(.4); expect(initial.point?.[1]).toBeCloseTo(0); expect(initial.point?.[2]).toBeCloseTo(0);
    expect(initial.revision).toBe(before.revision); expect(initial.canUndo).toBe(false);
    command({ command: 'transform', matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3, 0, 0, 1] });
    decode(core._sv_step(100));
    expect(command({ command: 'point', index: 1 }).point?.[0]).toBeCloseTo(3.4);
    command({ command: 'single', index: 1 }); command({ command: 'delete' });
    expect(command({ command: 'point', index: 1 }).point).toBeNull();
    expect(command({ command: 'point', index: 999 }).point).toBeNull();
    command({ command: 'undo' });
    expect(command({ command: 'point', index: 1 }).point?.[0]).toBeCloseTo(3.4);
  });
  it('rolls back an edit checkpoint with exact content, selection, history and redo', () => {
    open(); command({ command: 'single', index: 1 }); command({ command: 'delete' }); command({ command: 'undo' });
    const before = command({ command: 'summary' }), mask = core.HEAPU8.slice(core._sv_states_ptr(), core._sv_states_ptr() + 3);
    const coefficients = shWords(1);
    expect(core._sv_abi_version()).toBe(BUILD_DESCRIPTOR.native.core.abi); expect(before.canRedo).toBe(true);
    expect(command({ command: 'beginTransaction' }).transaction).toBe(true);
    command({ command: 'selectAll' }); command({ command: 'delete' });
    expect(command({ command: 'beginTransaction' }).ok).toBe(false);
    const restored = command({ command: 'rollbackTransaction' });
    expect(restored.transaction).toBe(false); expect(restored.revision).toBe(before.revision);
    expect(restored.contentRevision).toBe(before.contentRevision); expect(restored.canRedo).toBe(true);
    expect(restored.canUndo).toBe(before.canUndo); expect(restored.selected).toBe(1); expect(restored.visible).toBe(3);
    expect(shWords(1)).toEqual(coefficients); expect(core.HEAPU8.slice(core._sv_states_ptr(), core._sv_states_ptr() + 3)).toEqual(mask);
    expect(command({ command: 'redo' }).visible).toBe(2);
  });
  it('retains staged geometry through explicit commit and preserves its native Undo', () => {
    open(); const original = floats(0); command({ command: 'beginTransaction' });
    command({ command: 'transform', matrix: [2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3, 0, 0, 1] });
    const staged = decode(core._sv_step(100)); expect(staged.sceneChanged).toBe(true); expect(staged.transaction).toBe(true);
    expect(floats(0)[0]).toBeCloseTo(original[0] * 2 + 3);
    const committed = command({ command: 'commitTransaction' }); expect(committed.transaction).toBe(false);
    expect(committed.canUndo).toBe(true); command({ command: 'undo' }); expect(floats(0)).toEqual(original);
  });
  it('cancels a staged partial job then rolls back without losing a previous selection draft', () => {
    open(); command({ command: 'beginSelection' }); command({ command: 'single', index: 1 });
    const before = command({ command: 'summary' }); command({ command: 'beginTransaction' });
    command({ command: 'grade', values: [2, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] });
    decode(core._sv_step(1)); command({ command: 'cancel' });
    const restored = command({ command: 'rollbackTransaction' });
    expect(restored.selectionDraft).toBe(true); expect(restored.selected).toBe(before.selected);
    expect(restored.revision).toBe(before.revision); expect(restored.canUndo).toBe(false);
    expect(command({ command: 'cancelSelection' }).selected).toBe(0);
  });
  it.each([0, 1, 2, 3])('shrinking live region uses the original mask for Combine %i and records one Undo', operation => {
    open(); command({ command: 'single', index: 1 }); command({ command: 'beginSelection' });
    const request = { command: 'rectangle', camera: [0, 0, 0, 0, 0, 3, 1, 45, 0, 0, 1.6],
      width: 320, height: 200, operation, fromBaseline: true };
    const large = command({ ...request, rectangle: [100, 50, 220, 120] });
    expect(large.selected).toBe([3, 3, 0, 1][operation]);
    const small = command({ ...request, rectangle: [115, 90, 140, 110] });
    expect(small.selected).toBe([1, 2, 1, 0][operation]);
    command({ command: 'confirmSelection' });
    // Subtract's final region does not touch the baseline, so it adds no history.
    if (operation === 2) { expect(command({ command: 'undo' }).selected).toBe(0); return; }
    const undo = command({ command: 'undo' }); expect(undo.selected).toBe(1);
    expect(core.HEAPU8.slice(core._sv_states_ptr(), core._sv_states_ptr() + 3)).toEqual(new Uint8Array([0, 1, 0]));
    expect(command({ command: 'undo' }).selected).toBe(0);
  });
  it('decodes RDF coordinates, covariance and packed SH without a JS Gaussian model', () => {
    const summary = open(); expect(summary.ok).toBe(true); expect(summary.count).toBe(3); expect(summary.shDegree).toBe(3);
    const point = floats(2); expect(point[0]).toBe(0); expect(point[1]).toBeCloseTo(-.4); expect(point[2]).toBeCloseTo(-.1);
    expect(point[3]).toBeCloseTo(.8); expect(point[4]).toBeCloseTo(.12 ** 2, 6); expect(point[7]).toBeCloseTo(.1 ** 2, 6);
    expect(point[9]).toBeCloseTo(.08 ** 2, 6); expect(shWords(0)[0] & 65535).toBe(0x3800);
    expect(core._sv_pack(0, 3)).toBeGreaterThan(0); expect(core._sv_pack_len()).toBe(3 * 136);
  });
  it('keeps selection history separate from exported content and restores deletion', () => {
    open(); const selected = command({ command: 'single', index: 1 });
    expect(selected.selected).toBe(1); expect(selected.contentRevision).toBe(0);
    expect(command({ command: 'delete' }).visible).toBe(2);
    const undo = command({ command: 'undo' }); expect(undo.visible).toBe(3); expect(undo.selected).toBe(1);
    expect(undo.contentRevision).toBe(0); expect(command({ command: 'redo' }).visible).toBe(2);
  });
  it('grades selected coefficients in bounded steps, with one undoable commit', () => {
    open(); command({ command: 'single', index: 1 });
    const before = shWords(0), selectedBefore = shWords(1);
    let status = command({ command: 'grade', values: [2, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], selectedOnly: true });
    expect(status.pending).toBe(true); status = decode(core._sv_step(1)); expect(status.pending).toBe(true);
    status = decode(core._sv_step(100)); expect(status.pending).toBe(false); expect(status.contentRevision).not.toBe(0);
    expect(shWords(0)).toEqual(before); expect(shWords(1)).not.toEqual(selectedBefore);
    expect(command({ command: 'endColor' }).ok).toBe(true);
    command({ command: 'undo' }); expect(shWords(1)).toEqual(selectedBefore);
  });
  it('cancels a partially processed affine edit without changing committed data/history', () => {
    open(); const before = floats(0);
    command({ command: 'transform', matrix: [2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3, 0, 0, 1] });
    decode(core._sv_step(1)); command({ command: 'cancel' });
    expect(floats(0)).toEqual(before); expect(command({ command: 'summary' }).canUndo).toBe(false);
  });
  it.each([0, 1, 2, 3, 4, 5, 6, 7])('exports/reopens native format %i, with independent header checks', format => {
      expect(open().ok).toBe(true);
      const status = command({ command: 'export', format, scope: 0 }); expect(status.ok, status.error).toBe(true);
      const pointer = core._sv_output_ptr(), bytes = core.HEAPU8.slice(pointer, pointer + core._sv_output_len());
      expect(bytes.length).toBeGreaterThan(0);
      if (format === 0 || format === 3) expect(new TextDecoder().decode(bytes.subarray(0, 3))).toBe('ply');
      if (format === 1) { const header = gunzipSync(bytes); expect(header.readUInt32LE(0)).toBe(0x5053474e); expect(header.readUInt32LE(4)).toBe(3); }
      if (format === 2) expect(bytes.length).toBe(3 * 32);
      if (format === 5) expect(new TextDecoder().decode(bytes)).toContain('f_dc_0');
      else { const reopened = open(bytes, format === 2 ? 1 : format === 4 ? 2 : format >= 6 ? 3 : 0); expect(reopened.ok, reopened.error).toBe(true); expect(reopened.count).toBe(3); }
  });
  it('rejects malformed input and invalid grading values through the ABI', () => {
    expect(open(new Uint8Array([1, 2, 3, 4, 5])).ok).toBe(false);
    open(); expect(command({ command: 'grade', values: Array(15).fill(1e9) }).ok).toBe(false);
    expect(command({ command: 'summary' }).count).toBe(3);
  });
});

describe('admitted native selection-map adoption', () => {
  it.each([3, 7, 11, 15])('adopts channel flags %i without changing selection, content, Undo or Redo', channels => {
    open(); command({ command: 'single', index: 1 }); command({ command: 'delete' }); command({ command: 'undo' });
    const before = command({ command: 'summary' }), states = mask(), header = mapHeader({ channels });
    const payload = mapPayload(header), nativeBytes = payload.length + 4;
    const begun = command({ command: 'selectionMapBegin', ...header });
    expect(begun.ok).toBe(true); expect(begun.pendingSelectionMapId).toBe(header.mapId);
    expect(begun.selectionMapId).toBeNull(); expect(begun.selectionMapBytes).toBe(nativeBytes);
    expect(begun.memoryBytes).toBe(before.memoryBytes + nativeBytes);
    // Deliberately split both inside and across channel boundaries.
    let offset = 0;
    for (const length of [4, 24, payload.length - 28]) {
      expect(mapWrite(header.mapId, offset, payload.subarray(offset, offset + length)).ok).toBe(true); offset += length;
    }
    const adopted = command({ command: 'selectionMapCommit', mapId: header.mapId });
    expect(adopted.ok).toBe(true); expect(adopted.selectionMapId).toBe(header.mapId);
    expect(adopted.pendingSelectionMapId).toBeNull(); expect(adopted.selectionMapRetainedIds).toEqual([header.mapId]);
    expect(adopted.revision).toBe(before.revision); expect(adopted.contentRevision).toBe(before.contentRevision);
    expect(adopted.canUndo).toBe(before.canUndo); expect(adopted.canRedo).toBe(true); expect(mask()).toEqual(states);
    const released = command({ command: 'selectionMapRelease', mapId: header.mapId });
    expect(released.memoryBytes).toBe(before.memoryBytes); expect(released.selectionMapBytes).toBe(0);
    expect(released.selectionMapRetainedIds).toEqual([]); expect(released.revision).toBe(before.revision);
    expect(command({ command: 'redo' }).visible).toBe(2);
  });
  it('rejects reordered, replayed, oversized or misaligned writes without consuming valid input', () => {
    open(); const header = mapHeader(), bytes = mapPayload(header);
    command({ command: 'selectionMapBegin', ...header });
    const before = command({ command: 'summary' });
    for (const [id, offset, data] of [[header.mapId + 1, 0, bytes], [header.mapId, 4, bytes.subarray(0, 4)],
      [header.mapId, 0, bytes.subarray(0, 2)], [header.mapId, 0, new Uint8Array()],
      [header.mapId, 0, new Uint8Array(1024 * 1024 + 4)], [header.mapId, bytes.length + 4, bytes.subarray(0, 4)]] as const) {
      expect(mapWrite(id, offset, data).ok).toBe(false);
      expect(command({ command: 'summary' }).memoryBytes).toBe(before.memoryBytes);
    }
    const pointer = core._malloc(8);
    try {
      for (const invalid of [0, pointer + 2, core.HEAPU8.byteLength - 4])
        expect(decode(core._sv_map_write(header.mapId, 0, invalid, 8)).ok).toBe(false);
      for (const id of [0, -1, .5, NaN, Infinity, 9007199254740992])
        expect(decode(core._sv_map_write(id, 0, pointer, 4)).ok).toBe(false);
    } finally { core._free(pointer); }
    expect(mapWrite(header.mapId, 0, bytes.subarray(0, 4)).ok).toBe(true);
    expect(mapWrite(header.mapId, 0, bytes.subarray(0, 4)).ok).toBe(false);
    expect(command({ command: 'selectionMapCommit', mapId: header.mapId }).ok).toBe(false);
    expect(mapWrite(header.mapId, 4, bytes.subarray(4)).ok).toBe(true);
    expect(command({ command: 'selectionMapCommit', mapId: header.mapId }).selectionMapId).toBe(header.mapId);
    expect(mapWrite(header.mapId, 0, bytes).ok).toBe(false);
  });
  it.each(['depthNaN', 'depthInfinity', 'depthNegative', 'opacityNaN', 'opacityNegative', 'opacityHigh',
    'rgbNaN', 'rgbNegative', 'rgbHigh', 'visibilityTail'])('preserves the old active map after invalid %s content', invalid => {
    open(); const active = mapHeader({ fullWidth: 1, fullHeight: 1, mapWidth: 1, mapHeight: 1 });
    const before = adoptMap(active), candidate = mapHeader({ fullWidth: 1, fullHeight: 1, mapWidth: 1, mapHeight: 1 });
    expect(command({ command: 'selectionMapBegin', ...candidate }).ok).toBe(true);
    const bytes = mapPayload(candidate), view = new DataView(bytes.buffer);
    if (invalid === 'visibilityTail') view.setUint32(20, 8, true);
    else {
      const offset = invalid.startsWith('depth') ? 0 : invalid.startsWith('opacity') ? 4 : 12;
      view.setFloat32(offset, invalid.endsWith('NaN') ? NaN : invalid.endsWith('Infinity') ? Infinity : invalid.endsWith('High') ? 1.01 : -.01, true);
    }
    expect(mapWrite(candidate.mapId, 0, bytes).ok).toBe(true);
    expect(command({ command: 'selectionMapCommit', mapId: candidate.mapId }).ok).toBe(false);
    const refused = command({ command: 'summary' });
    expect(refused.selectionMapId).toBe(active.mapId); expect(refused.pendingSelectionMapId).toBe(candidate.mapId);
    expect(refused.revision).toBe(before.revision); expect(refused.contentRevision).toBe(before.contentRevision);
    expect(refused.selectionMapBytes).toBe(2 * before.selectionMapBytes);
    const canceled = command({ command: 'selectionMapRelease', mapId: candidate.mapId });
    expect(canceled.selectionMapId).toBe(active.mapId); expect(canceled.memoryBytes).toBe(before.memoryBytes);
    expect(canceled.selectionMapRetainedIds).toEqual([active.mapId]);
  });
  it('rejects visibility naming a deleted source and accepts original-ID bits across word boundaries', () => {
    open(colorPly(Array.from({ length: 35 }, () => [0, 0, 0])));
    command({ command: 'single', index: 33 }); command({ command: 'delete' });
    const header = mapHeader({ fullWidth: 1, fullHeight: 1, mapWidth: 1, mapHeight: 1, sourceCount: 35 });
    command({ command: 'selectionMapBegin', ...header });
    const bytes = mapPayload(header), view = new DataView(bytes.buffer);
    view.setUint32(20, 0x80000000, true); view.setUint32(24, 2, true); // IDs31 and33; ID33 is deleted.
    mapWrite(header.mapId, 0, bytes);
    expect(command({ command: 'selectionMapCommit', mapId: header.mapId }).ok).toBe(false);
    command({ command: 'selectionMapRelease', mapId: header.mapId });
    const next = mapHeader({ ...header, mapId: ++mapId });
    command({ command: 'selectionMapBegin', ...next }); view.setUint32(24, 4, true); // ID34 is valid.
    expect(mapWrite(next.mapId, 0, bytes).ok).toBe(true);
    expect(command({ command: 'selectionMapCommit', mapId: next.mapId }).selectionMapBytes).toBe(bytes.length + 8);
  });
  it('checks header dimensions, integer fields, required channels and monotonic attempted IDs before replacing a pending map', () => {
    open(); const old = mapHeader(); command({ command: 'selectionMapBegin', ...old });
    const before = command({ command: 'summary' });
    const invalid: Record<string, unknown>[] = [{ layoutVersion: 2 }, { channels: 1 }, { channels: 2 }, { channels: 19 },
      { channels: -1 }, { sourceCount: 2 }, { fullWidth: 0 }, { fullHeight: -1 }, { mapWidth: 0 },
      { fullWidth: 65536, fullHeight: 65536 }, { mapWidth: 262145, mapHeight: 1 },
      { fullWidth: 1025, fullHeight: 769, mapWidth: 512, mapHeight: 512 }, { mapWidth: 1.5 }, { fullWidth: '3' }];
    for (const changes of invalid) {
      const candidate = { ...mapHeader(), ...changes };
      expect(command({ command: 'selectionMapBegin', ...candidate }).ok).toBe(false);
      expect(command({ command: 'selectionMapBegin', ...candidate, ...old, mapId: candidate.mapId }).ok).toBe(false);
      const current = command({ command: 'summary' });
      expect(current.pendingSelectionMapId).toBe(old.mapId); expect(current.memoryBytes).toBe(before.memoryBytes);
      expect(current.revision).toBe(before.revision);
    }
    for (const id of [0, -1, .5, 9007199254740992, '1', null])
      expect(command({ command: 'selectionMapBegin', ...old, mapId: id }).ok).toBe(false);
    expect(command({ command: 'summary' }).pendingSelectionMapId).toBe(old.mapId);
  });
  it.each([[1025, 769], [1024, 1024], [1, 1]])('uses exact native floor sizing for full dimensions %i by %i', (fullWidth, fullHeight) => {
    open(); const scale = Math.min(1, Math.sqrt(262144 / (fullWidth * fullHeight)));
    const header = mapHeader({ fullWidth, fullHeight, mapWidth: Math.max(1, Math.floor(fullWidth * scale)),
      mapHeight: Math.max(1, Math.floor(fullHeight * scale)), channels: 3 });
    const begun = command({ command: 'selectionMapBegin', ...header });
    expect(begun.ok, begun.error).toBe(true); expect(header.mapWidth * header.mapHeight).toBeLessThanOrEqual(262144);
    expect(begun.selectionMapBytes).toBe(8 * header.mapWidth * header.mapHeight + 4);
    const bytes = mapPayload(header);
    for (let offset = 0; offset < bytes.length; offset += 1024 * 1024)
      expect(mapWrite(header.mapId, offset, bytes.subarray(offset, offset + 1024 * 1024)).ok).toBe(true);
    expect(command({ command: 'selectionMapCommit', mapId: header.mapId }).selectionMapId).toBe(header.mapId);
  });
  it('preserves maps through selected-mask-only history, drafts and Color amendments', () => {
    open(); const header = mapHeader(); adoptMap(header);
    for (const request of [{ command: 'single', index: 1 }, { command: 'undo' }, { command: 'redo' },
      { command: 'beginSelection' }, { command: 'selectAll' }, { command: 'cancelSelection' }])
      expect(command(request).selectionMapId).toBe(header.mapId);
    const id = nextToleranceId(); expect(pickColor(id, 1).selectionMapId).toBe(header.mapId);
    expect(adjustColor(id, 0).selectionMapId).toBe(header.mapId);
    const summary = command({ command: 'summary' }); expect(summary.contentRevision).toBe(0);
    expect(summary.selectionMapRetainedIds).toEqual([header.mapId]);
  });
  it('uses the loaded source-ID domain when native preview sampling reduces the original source count', () => {
    const opened = open(colorPly(Array.from({ length: 1501 }, () => [0, 0, 0])));
    expect(opened.count).toBe(1000); expect(opened.sourceCount).toBe(1501);
    const wrong = mapHeader({ sourceCount: opened.sourceCount });
    expect(command({ command: 'selectionMapBegin', ...wrong }).ok).toBe(false);
    const header = mapHeader({ sourceCount: opened.count });
    const adopted = adoptMap(header);
    expect(adopted.selectionMapBytes).toBe(mapPayload(header).length + 4 * Math.ceil(opened.count / 32));
  });
  it('keeps the same native map through a successful selection-only publication transaction', () => {
    open(); const header = mapHeader(), original = adoptMap(header);
    command({ command: 'beginTransaction' }); command({ command: 'single', index: 1 });
    const committed = command({ command: 'commitTransaction' });
    expect(committed.selectionMapId).toBe(header.mapId); expect(committed.selectionMapBytes).toBe(original.selectionMapBytes);
    expect(committed.selectionMapRetainedIds).toEqual([header.mapId]); expect(mask()).toEqual([0, 1, 0]);
    expect(command({ command: 'undo' }).selectionMapId).toBe(header.mapId);
  });
  it.each(['delete', 'crop', 'restore', 'resetCleanup', 'grade', 'transform', 'open'])('releases stale native maps after %s', mutation => {
    open();
    if (mutation === 'restore' || mutation === 'resetCleanup') {
      command({ command: 'single', index: 1 }); command({ command: 'delete' });
    }
    const header = mapHeader(); adoptMap(header);
    if (mutation === 'delete') { command({ command: 'selectAll' }); command({ command: 'delete' }); }
    else if (mutation === 'crop') { command({ command: 'single', index: 1 }); command({ command: 'crop' }); }
    else if (mutation === 'grade' || mutation === 'transform') {
      const request = mutation === 'grade' ? { command: 'grade', values: [2, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] }
        : { command: 'transform', matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 1] };
      expect(command(request).selectionMapId).toBe(header.mapId); decode(core._sv_step(100));
    } else if (mutation === 'open') open();
    else command({ command: mutation });
    const current = command({ command: 'summary' });
    expect(current.selectionMapId).toBeNull(); expect(current.pendingSelectionMapId).toBeNull();
    expect(current.selectionMapBytes).toBe(0); expect(current.selectionMapRetainedIds).toEqual([]);
    expect(command({ command: 'selectionMapRelease', mapId: header.mapId }).selectionMapBytes).toBe(0);
    expect(command({ command: 'selectionMapBegin', ...header }).ok).toBe(false);
  });
  it('rejects a pending map after content mutation but permits selected-mask changes during upload', () => {
    open(); const header = mapHeader(), bytes = mapPayload(header);
    command({ command: 'selectionMapBegin', ...header }); mapWrite(header.mapId, 0, bytes.subarray(0, 4));
    expect(command({ command: 'single', index: 1 }).pendingSelectionMapId).toBe(header.mapId);
    expect(mapWrite(header.mapId, 4, bytes.subarray(4)).ok).toBe(true);
    expect(command({ command: 'selectionMapCommit', mapId: header.mapId }).selectionMapId).toBe(header.mapId);
    const next = mapHeader(); command({ command: 'selectionMapBegin', ...next });
    const deleted = command({ command: 'delete' }); expect(deleted.selectionMapBytes).toBe(0);
    expect(mapWrite(next.mapId, 0, mapPayload(next)).ok).toBe(false);
    expect(command({ command: 'selectionMapCommit', mapId: next.mapId }).ok).toBe(false);
  });
  it('cancels only pending data, atomically replaces an active map, and ignores stale releases', () => {
    open(); const first = mapHeader(), initial = adoptMap(first), pending = mapHeader();
    command({ command: 'selectionMapBegin', ...pending });
    const canceled = command({ command: 'cancel' });
    expect(canceled.selectionMapId).toBe(first.mapId); expect(canceled.pendingSelectionMapId).toBeNull();
    expect(canceled.memoryBytes).toBe(initial.memoryBytes);
    const replacement = mapHeader(); const adopted = adoptMap(replacement);
    expect(adopted.memoryBytes).toBe(initial.memoryBytes); expect(adopted.selectionMapRetainedIds).toEqual([replacement.mapId]);
    for (const id of [first.mapId, pending.mapId]) {
      const stale = command({ command: 'selectionMapRelease', mapId: id });
      expect(stale.selectionMapId).toBe(replacement.mapId); expect(stale.memoryBytes).toBe(adopted.memoryBytes);
    }
  });
  it('retains and restores the exact active map across a refused/released edit transaction without double charging', () => {
    open(); const header = mapHeader(), original = adoptMap(header);
    const begun = command({ command: 'beginTransaction' });
    expect(begun.selectionMapBytes).toBe(original.selectionMapBytes); expect(begun.selectionMapRetainedIds).toEqual([header.mapId]);
    const attempted = mapHeader(); expect(command({ command: 'selectionMapBegin', ...attempted }).ok).toBe(false);
    const released = command({ command: 'selectionMapRelease', mapId: header.mapId });
    expect(released.selectionMapId).toBeNull(); expect(released.selectionMapBytes).toBe(original.selectionMapBytes);
    expect(released.selectionMapRetainedIds).toEqual([header.mapId]);
    const restored = command({ command: 'rollbackTransaction' }); expect(restored.selectionMapId).toBe(header.mapId);
    expect(restored.selectionMapBytes).toBe(original.selectionMapBytes); expect(restored.revision).toBe(original.revision);
    expect(command({ command: 'selectionMapBegin', ...attempted }).ok).toBe(false);
    command({ command: 'beginTransaction' }); command({ command: 'selectAll' });
    const deleted = command({ command: 'delete' }); expect(deleted.selectionMapId).toBeNull();
    expect(deleted.selectionMapRetainedIds).toEqual([header.mapId]); expect(deleted.selectionMapBytes).toBe(original.selectionMapBytes);
    expect(command({ command: 'rollbackTransaction' }).selectionMapId).toBe(header.mapId); expect(mask()).toEqual([0, 0, 0]);
    command({ command: 'beginTransaction' }); command({ command: 'selectAll' }); command({ command: 'delete' });
    const committed = command({ command: 'commitTransaction' });
    expect(committed.selectionMapBytes).toBe(0); expect(committed.selectionMapRetainedIds).toEqual([]);
  });
  it('keeps active/pending maps and exact memory when later channel allocation is refused', () => {
    resetBudgetFixtureOwner();
    // 128 KiB admits source/header scratch during load. After load, the two
    // 32 KiB depth/opacity arrays fit but the 96 KiB RGB allocation cannot.
    const budgetBytes = 128 * 1024;
    expect(open(gaussianPly(), 0, budgetBytes).ok).toBe(true);
    const active = mapHeader(), original = adoptMap(active), pending = mapHeader();
    command({ command: 'selectionMapBegin', ...pending }); const before = command({ command: 'summary' });
    const oversized = mapHeader({ fullWidth: 64, fullHeight: 128, mapWidth: 64, mapHeight: 128 });
    const pixels = 64 * 128;
    expect(before.memoryBytes + 8 * pixels).toBeLessThan(budgetBytes);
    expect(before.memoryBytes + 20 * pixels).toBeGreaterThan(budgetBytes);
    const refused = command({ command: 'selectionMapBegin', ...oversized });
    expect(refused.ok).toBe(false); expect(refused.error).toMatch(/resource byte limit exceeded/i);
    expect(refused.error).toContain(`requested ${12 * pixels}`); // RGB fails after both float32 depth/opacity arrays were admitted.
    const unchanged = command({ command: 'summary' });
    expect(unchanged.selectionMapId).toBe(active.mapId); expect(unchanged.pendingSelectionMapId).toBe(pending.mapId);
    expect(unchanged.memoryBytes).toBe(before.memoryBytes); expect(unchanged.revision).toBe(before.revision);
    expect(command({ command: 'selectionMapBegin', ...oversized }).ok).toBe(false);
    mapWrite(pending.mapId, 0, mapPayload(pending));
    const adopted = command({ command: 'selectionMapCommit', mapId: pending.mapId });
    expect(adopted.memoryBytes).toBe(original.memoryBytes); expect(adopted.selectionMapId).toBe(pending.mapId);
  });
  it('refuses map mutation during an edit job without cancelling the job, and refuses editing during pending transport', () => {
    open(); const header = mapHeader(); command({ command: 'selectionMapBegin', ...header });
    const before = command({ command: 'summary' }); expect(command({ command: 'beginTransaction' }).ok).toBe(false);
    expect(command({ command: 'summary' }).revision).toBe(before.revision);
    command({ command: 'selectionMapRelease', mapId: header.mapId });
    const active = mapHeader(); adoptMap(active);
    command({ command: 'grade', values: [2, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] });
    const attempted = mapHeader(); expect(command({ command: 'selectionMapBegin', ...attempted }).ok).toBe(false);
    expect(command({ command: 'selectionMapCommit', mapId: attempted.mapId }).ok).toBe(false);
    const queried = command({ command: 'summary' });
    expect(queried.pending).toBe(true); expect(queried.selectionMapId).toBe(active.mapId);
    expect(queried.selectionMapRetainedIds).toEqual([active.mapId]);
    expect(decode(core._sv_step(1)).pending).toBe(true);
    expect(decode(core._sv_step(100)).contentRevision).toBeGreaterThan(0);
  });
  it('preserves safe numeric map IDs above 32 bits across the JSON and C write boundary', () => {
    open(); mapId = 2 ** 32 + 17; const header = mapHeader();
    const adopted = adoptMap(header); expect(adopted.selectionMapId).toBe(header.mapId);
    expect(command({ command: 'selectionMapRelease', mapId: header.mapId }).selectionMapBytes).toBe(0);
  });
  it('unprojects pixel centers and scales Volume radius independently of Gaussian size', () => {
    volumeScene([[.18, 0, 0], [.185, 0, 0], [0, 0, .2]]);
    const header = volumeMap(), before = command({ command: 'summary' });
    const selected = command(volumeRequest(header)); expect(selected.ok, selected.error).toBe(true);
    // FOV90, height33, depth3: world radius = 2*3/33 = .18181818.
    expect(mask()).toEqual([1, 0, 0]); expect(selected.contentRevision).toBe(before.contentRevision);
    expect(selected.selectionMapId).toBe(header.mapId); expect(selected.selectionMapBytes).toBe(before.selectionMapBytes);
    expect(command({ command: 'undo' }).selected).toBe(0);
    expect(command({ command: 'redo' }).selected).toBe(1);
  });
  it('uses anisotropic 3-sigma ellipsoid intersection only when touched edges is enabled', () => {
    volumeScene([[.45, 0, 0], [0, .45, 0], [0, 0, .45]], [.01, .0004, .0004]);
    const header = volumeMap(); command(volumeRequest(header)); expect(mask()).toEqual([0, 0, 0]);
    command(volumeRequest(header, { overlap: true })); expect(mask()).toEqual([1, 0, 0]);
  });
  it('interpolates depth within 5% and excludes background neighbors at noninteger map scales', () => {
    const width = 1025, height = 769, x = 511, y = 383;
    const scale = Math.sqrt(262144 / (width * height)), mw = Math.floor(width * scale), mh = Math.floor(height * scale);
    const px = (x + .5) * mw / width - .5, py = (y + .5) * mh / height - .5;
    const left = Math.floor(px), top = Math.floor(py), fx = px - left, fy = py - top;
    const seedX = Math.floor(x * mw / width), seedY = Math.floor(y * mh / height);
    const depthAt = (column: number, row: number) => column === seedX && row === seedY ? 3 :
      column === left + 1 && row === top ? Math.fround(3.12) : Math.fround(3.3);
    let sum = 0, weight = 0;
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const d = depthAt(left + dx, top + dy), w = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy);
      if (Math.abs(d - 3) <= .15) { sum += w * d; weight += w; }
    }
    const depth = sum / weight;
    expect(depth).toBeGreaterThan(3.001); expect(depth).toBeLessThan(3.12);
    const center = (d: number) => [((x + .5) * 2 / width - 1) * d * width / height,
      (1 - (y + .5) * 2 / height) * d, 3 - d];
    volumeScene([center(depth), center(3), center(3.3)]);
    const header = volumeMap(width, height, depthAt);
    const selected = command(volumeRequest(header, { points: [[x, y]], radius: .1 }));
    expect(selected.ok, selected.error).toBe(true); expect(mask()).toEqual([1, 0, 0]);
  });
  it.each(['volume', 'brush'])('consumes global original-ID visibility for %s across bitset word boundaries', kind => {
    volumeScene(Array.from({ length: 35 }, () => [0, 0, 0]));
    const header = volumeMap(33, 33, 3, [1, 34], 35);
    const selected = command(volumeRequest(header, { command: kind, visibleOnly: true }));
    expect(selected.ok, selected.error).toBe(true);
    expect(mask(35)).toEqual(Array.from({ length: 35 }, (_, i) => i === 1 || i === 34 ? 1 : 0));
    expect(selected.selectionMapId).toBe(header.mapId);
  });
  it.each([0, 1, 2, 3])('shrinks an absolute Volume Combine %i preview from the fixed original mask with one Undo', operation => {
    volumeScene([[-.4, 0, 0], [.4, 0, 0], [0, .4, 0]]);
    command({ command: 'single', index: 1 }); const header = volumeMap();
    command({ command: 'beginSelection' });
    const request = volumeRequest(header, { operation, fromBaseline: true });
    expect(command({ ...request, radius: 3 }).selected).toBe([3, 3, 0, 1][operation]);
    const small = command({ ...request, points: [[13, 16]] }); expect(small.ok, small.error).toBe(true);
    expect(mask()).toEqual([[1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 0]][operation]);
    expect(command({ command: 'confirmSelection' }).selectionDraft).toBe(false);
    if (operation === 2) expect(command({ command: 'undo' }).selected).toBe(0);
    else { expect(command({ command: 'undo' }).selected).toBe(1); expect(mask()).toEqual([0, 1, 0]); }
  });
  it('resamples complete Volume segments and gives the same final live/deferred result for the same captured path', () => {
    const execute = (live: boolean) => {
      volumeScene([[-.8, 0, 0], [0, 0, 0], [.8, 0, 0]]); const header = volumeMap();
      command({ command: 'beginSelection' });
      const request = volumeRequest(header, { radius: 1.1, fromBaseline: true });
      if (live) command({ ...request, points: [[11, 16]] });
      const complete = command({ ...request, points: [[11, 16], [21, 16]] });
      expect(complete.ok, complete.error).toBe(true); expect(mask()).toEqual([1, 1, 1]);
      command({ command: 'confirmSelection' }); const result = mask();
      expect(command({ command: 'undo' }).selected).toBe(0); expect(command({ command: 'undo' }).canRedo).toBe(true);
      return result;
    };
    expect(execute(true)).toEqual(execute(false));
  });
  it.each([{ points: [] }, { points: [[-1, -1]] }, { points: [[33, 33]] }])('restores an absolute Volume baseline for an empty/offscreen path %j', ({ points }) => {
    volumeScene([[0, 0, 0], [.4, 0, 0], [0, .4, 0]]); command({ command: 'single', index: 1 });
    const header = volumeMap(); command({ command: 'beginSelection' });
    command(volumeRequest(header, { fromBaseline: true })); expect(mask()).toEqual([1, 0, 0]);
    command(volumeRequest(header, { fromBaseline: true, points })); expect(mask()).toEqual([0, 1, 0]);
    command({ command: 'confirmSelection' }); expect(command({ command: 'undo' }).selected).toBe(0);
  });
  it('preserves selection and Redo for zero-depth Volume samples and cancels a live selection exactly', () => {
    volumeScene([[0, 0, 0], [.4, 0, 0], [0, .4, 0]]);
    command({ command: 'single', index: 1 }); command({ command: 'single', index: 2 }); command({ command: 'undo' });
    const empty = volumeMap(33, 33, 0), before = command({ command: 'summary' });
    const unchanged = command(volumeRequest(empty)); expect(unchanged.revision).toBe(before.revision);
    expect(unchanged.canRedo).toBe(true); expect(mask()).toEqual([0, 1, 0]);
    const valid = volumeMap(); command({ command: 'beginSelection' });
    command(volumeRequest(valid, { fromBaseline: true })); expect(mask()).toEqual([1, 0, 0]);
    const cancelled = command({ command: 'cancelSelection' }); expect(cancelled.canRedo).toBe(true);
    expect(mask()).toEqual([0, 1, 0]); expect(command({ command: 'redo' }).selected).toBe(1);
    expect(mask()).toEqual([0, 0, 1]);
  });
  it('restores exact Volume mask/history/draft/map state after failed publication rollback', () => {
    volumeScene([[0, 0, 0], [.4, 0, 0], [0, .4, 0]]); command({ command: 'single', index: 1 });
    const header = volumeMap(); command({ command: 'beginSelection' });
    command(volumeRequest(header, { fromBaseline: true })); const previous = command({ command: 'summary' }), bytes = mask();
    command({ command: 'beginTransaction' }); command(volumeRequest(header, { fromBaseline: true, radius: 3 }));
    const restored = command({ command: 'rollbackTransaction' }); expect(mask()).toEqual(bytes);
    for (const key of ['revision', 'contentRevision', 'canUndo', 'canRedo', 'selectionDraft', 'selectionMapId', 'selectionMapBytes'] as const)
      expect(restored[key]).toEqual(previous[key]);
    command({ command: 'cancelSelection' }); expect(mask()).toEqual([0, 1, 0]);
  });
  it('accepts thin admitted Volume maps wider than the obsolete portable 8192 limit', () => {
    volumeScene([[3, 0, 0], [0, 0, 0], [-3, 0, 0]]); const header = volumeMap(20000, 1);
    const selected = command(volumeRequest(header, { points: [[10000, 0]], radius: .01 }));
    expect(selected.ok, selected.error).toBe(true); expect(mask()).toEqual([1, 0, 0]);
  });
  it('rejects malformed or unavailable Volume/visible Brush dependencies before changing a live preview', () => {
    volumeScene([[0, 0, 0], [.4, 0, 0], [0, .4, 0]]); const header = volumeMap();
    command({ command: 'beginSelection' }); command(volumeRequest(header, { fromBaseline: true }));
    const previous = command({ command: 'summary' });
    for (const extra of [{ mapId: header.mapId + 1 }, { width: 32 }, { height: 32 }, { width: -1 },
      { radius: 0 }, { radius: -1 }, { camera: volumeCamera.toSpliced(5, 1, 0) },
      { camera: volumeCamera.toSpliced(7, 1, 5) }, { points: [[1.5, 2]] }, { points: [[2 ** 31, 0]] },
      { points: [[0]] }, { visibleOnly: true }, { command: 'brush', visibleOnly: true }]) {
      expect(command(volumeRequest(header, { fromBaseline: true, ...extra })).ok).toBe(false);
      const after = command({ command: 'summary' }); expect(mask()).toEqual([1, 0, 0]);
      for (const key of ['revision', 'contentRevision', 'canUndo', 'canRedo', 'selectionDraft', 'selectionMapBytes'] as const)
        expect(after[key]).toEqual(previous[key]);
    }
  });
  it('rejects excessive Volume sample attempts and admitted scratch refusal without losing previous preview/Redo', () => {
    resetBudgetFixtureOwner();
    const budgetBytes = 128 * 1024;
    volumeScene([[0, 0, 0], [.4, 0, 0], [0, .4, 0]], undefined, budgetBytes);
    command({ command: 'single', index: 1 }); command({ command: 'single', index: 2 }); command({ command: 'undo' });
    const header = volumeMap(); command({ command: 'beginSelection' });
    command(volumeRequest(header, { fromBaseline: true })); const previous = command({ command: 'summary' });
    const capped = command(volumeRequest(header, { fromBaseline: true, points: [[0, 0], [2147483647, 0]] }));
    expect(capped.ok).toBe(false); expect(capped.error).toMatch(/sample budget/);
    // Every repeated point produces one 16-byte world sample. The 48 KiB
    // input path fits, but its path + 96 KiB of samples cannot coexist under
    // 128 KiB even without vector growth, candidate copies or BVH nodes.
    const points = Array.from({ length: 6000 }, () => [16, 16]);
    expect(previous.memoryBytes + 8 * points.length).toBeLessThan(budgetBytes);
    expect(previous.memoryBytes + 24 * points.length).toBeGreaterThan(budgetBytes);
    const refused = command(volumeRequest(header, { fromBaseline: true, points }));
    expect(refused.ok).toBe(false); expect(refused.error).toMatch(/resource|budget|limit/i);
    const after = command({ command: 'summary' }); expect(mask()).toEqual([1, 0, 0]);
    for (const key of ['revision', 'contentRevision', 'canUndo', 'canRedo', 'selectionDraft', 'memoryBytes', 'selectionMapBytes'] as const)
      expect(after[key]).toEqual(previous[key]);
    expect(command({ command: 'cancelSelection' }).canRedo).toBe(true); expect(mask()).toEqual([0, 1, 0]);
  });
  it('rejects deleted/replaced map identities and never selects a deleted source', () => {
    volumeScene([[0, 0, 0], [0, 0, 0], [0, 0, 0]]); const stale = volumeMap();
    command({ command: 'single', index: 1 }); command({ command: 'delete' });
    expect(command(volumeRequest(stale)).ok).toBe(false); expect(mask()).toEqual([0, 2, 0]);
    const valid = volumeMap(); expect(command(volumeRequest(valid)).ok).toBe(true); expect(mask()).toEqual([1, 2, 1]);
    volumeScene([[0, 0, 0], [0, 0, 0], [0, 0, 0]]);
    expect(command(volumeRequest(valid)).ok).toBe(false); expect(mask()).toEqual([0, 0, 0]);
  });
  it('floods Fill by fixed-seed opacity rather than drifting through a neighbor gradient', () => {
    screenScene([[1, 2], [3, 2], [4, 2]]);
    const header = fillMap((x, y) => y !== 2 ? 0 : ([0, .5, .55, .59, .66][x] ?? 0));
    const id = nextToleranceId(), picked = command(fillRequest(header, id));
    expect(picked.ok, picked.error).toBe(true); expect(mask()).toEqual([1, 1, 0]);
    expect(adjustFill(id, 1).ok).toBe(true); expect(mask()).toEqual([1, 1, 1]);
    expect(adjustFill(id, 0).ok).toBe(true); expect(mask()).toEqual([1, 0, 0]);
    expect(command({ command: 'undo' }).selected).toBe(0);
  });
  it('does not connect diagonal Fill islands or cross empty gaps at maximum tolerance', () => {
    screenScene([[1, 1], [2, 2], [5, 1]]);
    const header = fillMap((x, y) => x === 1 && y === 1 || x === 2 && y === 2 || x === 5 && y === 1 ? .5 : 0);
    const picked = command(fillRequest(header, nextToleranceId(), 1, { seed: [1, 1] }));
    expect(picked.ok, picked.error).toBe(true); expect(mask()).toEqual([1, 0, 0]);
  });
  it('uses exact opacity eligibility and domain tolerance without a second UI square', () => {
    screenScene([[1, 2], [2, 2], [3, 2]]);
    const header = fillMap((x, y) => y === 2 && x >= 1 && x <= 3 ? [.5, .625, .75][x - 1] : 0);
    const id = nextToleranceId(); command(fillRequest(header, id, .125)); expect(mask()).toEqual([1, 1, 0]);
    adjustFill(id, -.1); expect(mask()).toEqual([1, 0, 0]);
    adjustFill(id, 2); expect(mask()).toEqual([1, 1, 1]);
    const minimum = fillMap((x, y) => y !== 2 ? 0 : x === 1 ? 1 / 255 : x === 2 ? .99 / 255 : x === 3 ? .5 : 0);
    const next = nextToleranceId(); command(fillRequest(minimum, next, 1)); expect(mask()).toEqual([1, 0, 0]);
    expect(command(fillRequest(minimum, nextToleranceId(), 1, { seed: [2, 2] })).toleranceSessionId).toBe(next);
  });
  it.each([false, true])('uses the exact native projected footprint with Fill visibleOnly=%s', visibleOnly => {
    screenScene([[3, 2], [4.4, 2], [5.5, 2]]);
    const header = fillMap((x, y) => x === 3 && y === 2 ? .5 : 0, [0]);
    command(fillRequest(header, nextToleranceId(), 0, { seed: [3, 2], visibleOnly })); expect(mask()).toEqual([1, 0, 0]);
    command(fillRequest(header, nextToleranceId(), 0, { seed: [3, 2], overlap: true, visibleOnly }));
    expect(mask()).toEqual(visibleOnly ? [1, 0, 0] : [1, 1, 0]);
  });
  it('maps Fill seed and Gaussian centers independently in X/Y at a noninteger floor scale', () => {
    const width = 1025, height = 769, scale = Math.sqrt(262144 / (width * height));
    const mw = Math.floor(width * scale), mh = Math.floor(height * scale), mx = 200, my = 100;
    screenScene([[mx, my], [mx + 1, my], [mx, my + 1]].map(([x, y]) =>
      [(x + .5) * width / mw - .5, (y + .5) * height / mh - .5]), width, height);
    const header = fillMap((x, y) => y === my && (x === mx || x === mx + 1) ? .5 : 0, undefined, width, height);
    const seed = [Math.ceil(mx * width / mw), Math.ceil(my * height / mh)];
    const picked = command(fillRequest(header, nextToleranceId(), 0, { seed }));
    expect(picked.ok, picked.error).toBe(true); expect(mask()).toEqual([1, 1, 0]);
  });
  it.each([0, 1, 2, 3])('amends completed Fill Combine %i from the original mask with one history item', operation => {
    screenScene([[1, 2], [2, 2], [3, 2]]); command({ command: 'single', index: 1 });
    const header = fillMap((x, y) => y === 2 && x >= 1 && x <= 3 ? [.5, .625, .75][x - 1] : 0);
    const id = nextToleranceId(), picked = command(fillRequest(header, id, 1, { operation }));
    expect(picked.selected).toBe([3, 3, 0, 1][operation]);
    const reduced = adjustFill(id, 0); expect(reduced.ok, reduced.error).toBe(true);
    expect(mask()).toEqual([[1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 0]][operation]);
    if (operation === 2) expect(command({ command: 'undo' }).selected).toBe(0);
    else { command({ command: 'undo' }); expect(mask()).toEqual([0, 1, 0]); }
  });
  it('preserves Fill no-op Redo then grows/returns to baseline/grows with monotonic revisions', () => {
    screenScene([[1, 2], [2, 2], [3, 2]]);
    command({ command: 'single', index: 0 }); command({ command: 'single', index: 1 }); command({ command: 'undo' });
    const header = fillMap((x, y) => y === 2 && x >= 1 && x <= 3 ? [.5, .625, .75][x - 1] : 0);
    const before = command({ command: 'summary' }), id = nextToleranceId();
    const noop = command(fillRequest(header, id, 0)); expect(noop.revision).toBe(before.revision); expect(noop.canRedo).toBe(true);
    const growth = adjustFill(id, 1); expect(growth.revision).toBeGreaterThan(noop.revision); expect(growth.canRedo).toBe(false);
    const baseline = adjustFill(id, 0); expect(baseline.revision).toBeGreaterThan(growth.revision); expect(mask()).toEqual([1, 0, 0]);
    const again = adjustFill(id, 1); expect(again.revision).toBeGreaterThan(baseline.revision);
    command({ command: 'undo' }); expect(mask()).toEqual([1, 0, 0]);
    command({ command: 'undo' }); expect(mask()).toEqual([0, 0, 0]);
  });
  it('shares Fill/Color ID ownership and preserves the prior owner on empty or refused replacements', () => {
    screenScene([[1, 2], [2, 2], [3, 2]]); const header = fillMap((x, y) => y === 2 && x === 1 ? .5 : 0);
    const color = nextToleranceId(); pickColor(color, 0);
    const empty = command(fillRequest(header, nextToleranceId(), 1, { seed: [0, 0] })); expect(empty.toleranceSessionId).toBe(color);
    expect(adjustFill(color, 1).ok).toBe(false); expect(adjustColor(color, 0).ok).toBe(true);
    const fill = nextToleranceId(); command(fillRequest(header, fill, 0));
    expect(adjustColor(fill, 1).ok).toBe(false); expect(adjustFill(fill, 0).ok).toBe(true);
    for (const extra of [{ seed: [-1, 0] }, { seed: [7, 5] }, { seed: [0, 0] }])
      expect(command(fillRequest(header, nextToleranceId(), 1, extra)).toleranceSessionId).toBe(fill);
    const invalidId = nextToleranceId(); expect(command(fillRequest(header, invalidId, 1, { mapId: header.mapId + 1 })).ok).toBe(false);
    expect(command(fillRequest(header, invalidId, 1)).ok).toBe(false);
    expect(command({ command: 'summary' }).toleranceSessionId).toBe(fill);
    expect(command({ command: 'endTolerance', sessionId: color }).toleranceSessionId).toBe(fill);
  });
  it('retains captured Fill channels across active upgrade/release and releases the final owner once', () => {
    screenScene([[1, 2], [2, 2], [3, 2]]); const opacity = (x: number, y: number) => y === 2 && x >= 1 && x <= 3 ? .5 + (x - 1) / 8 : 0;
    const original = fillMap(opacity), id = nextToleranceId(); command(fillRequest(original, id, 0));
    const one = command({ command: 'summary' }); expect(one.selectionMapRetainedIds).toEqual([original.mapId]);
    const replacement = fillMap(() => 0); const two = command({ command: 'summary' });
    expect(two.selectionMapRetainedIds).toEqual([replacement.mapId, original.mapId]); expect(two.selectionMapBytes).toBe(2 * one.selectionMapBytes);
    command({ command: 'selectionMapRelease', mapId: original.mapId });
    const held = command({ command: 'selectionMapRelease', mapId: replacement.mapId });
    expect(held.selectionMapId).toBeNull(); expect(held.selectionMapRetainedIds).toEqual([original.mapId]);
    expect(held.selectionMapBytes).toBe(one.selectionMapBytes);
    expect(adjustFill(id, 1).selected).toBe(3);
    const ended = command({ command: 'endTolerance', sessionId: id }); expect(ended.selectionMapBytes).toBe(0);
    expect(ended.selectionMapRetainedIds).toEqual([]); expect(ended.toleranceSessionId).toBeNull();
  });
  it('restores Fill owner and held maps on transaction rollback and never reuses attempted IDs', () => {
    screenScene([[1, 2], [2, 2], [3, 2]]);
    const header = fillMap((x, y) => y === 2 && x >= 1 && x <= 3 ? .5 + (x - 1) / 8 : 0);
    const id = nextToleranceId(); command(fillRequest(header, id, .125));
    command({ command: 'selectionMapRelease', mapId: header.mapId }); const before = command({ command: 'summary' }), bytes = mask();
    command({ command: 'beginTransaction' });
    adjustFill(id, 1); command({ command: 'endTolerance', sessionId: id });
    expect(command({ command: 'summary' }).selectionMapRetainedIds).toEqual([header.mapId]);
    const color = nextToleranceId(); pickColor(color, 0);
    const restored = command({ command: 'rollbackTransaction' }); expect(restored.toleranceSessionId).toBe(id); expect(mask()).toEqual(bytes);
    for (const key of ['revision', 'contentRevision', 'canUndo', 'canRedo', 'selectionMapBytes', 'selectionMapRetainedIds'] as const)
      expect(restored[key]).toEqual(before[key]);
    expect(pickColor(color, 1).ok).toBe(false); expect(adjustFill(id, 0).ok).toBe(true);
    command({ command: 'beginTransaction' }); command({ command: 'endTolerance', sessionId: id });
    expect(command({ command: 'commitTransaction' }).selectionMapBytes).toBe(0);
  });
  it.each(['single', 'undo', 'draft', 'delete', 'open'])('invalidates Fill checkpoint and frees held map after unrelated %s', mutation => {
    screenScene([[1, 2], [2, 2], [3, 2]]); const header = fillMap((x, y) => y === 2 && x === 1 ? .5 : 0);
    const id = nextToleranceId(); command(fillRequest(header, id, 0)); command({ command: 'selectionMapRelease', mapId: header.mapId });
    if (mutation === 'open') screenScene([[1, 2], [2, 2], [3, 2]]);
    else command({ command: mutation === 'draft' ? 'beginSelection' : mutation, index: 1 });
    const summary = command({ command: 'summary' }); expect(summary.toleranceSessionId).toBeNull();
    expect(summary.selectionMapBytes).toBe(0); expect(summary.selectionMapRetainedIds).toEqual([]);
    expect(adjustFill(id, 1).ok).toBe(false);
  });
  it('rejects malformed Fill dependencies without changing the completed owner, mask, history or bytes', () => {
    screenScene([[1, 2], [2, 2], [3, 2]]); const header = fillMap((x, y) => y === 2 && x === 1 ? .5 : 0);
    const id = nextToleranceId(); command(fillRequest(header, id, 0)); const before = command({ command: 'summary' });
    for (const extra of [{ width: 8 }, { height: 6 }, { seed: [1.5, 2] }, { seed: [2 ** 31, 0] }, { seed: [1] },
      { visibleOnly: true }, { operation: 5 }, { camera: volumeCamera.toSpliced(5, 1, 0) }]) {
      expect(command(fillRequest(header, nextToleranceId(), 0, extra)).ok).toBe(false);
      const current = command({ command: 'summary' }); expect(mask()).toEqual([1, 0, 0]);
      for (const key of ['revision', 'contentRevision', 'canUndo', 'canRedo', 'toleranceSessionId', 'selectionMapBytes', 'memoryBytes'] as const)
        expect(current[key]).toEqual(before[key]);
    }
  });
  it('refuses admitted Fill scratch atomically for a replacement and preserves its previous adjustable click', () => {
    resetBudgetFixtureOwner();
    const budgetBytes = 128 * 1024;
    screenScene([[1, 2], [2, 2], [3, 2]], 7, 5, undefined, budgetBytes);
    const original = fillMap((x, y) => y === 2 && x === 1 ? .5 : 0), id = nextToleranceId();
    command(fillRequest(original, id, 0)); const large = fillMap(() => .5, undefined, 128, 80);
    const before = command({ command: 'summary' }), attempted = nextToleranceId();
    // The admitted 80 KiB map fits. Flood's 1.25 KiB mask and 10 KiB visited
    // array fit too; its independent 40 KiB queue must refuse before selection.
    const pixels = 128 * 80, maskBytes = 2 * 8 * 80;
    expect(before.memoryBytes + maskBytes + pixels).toBeLessThan(budgetBytes);
    expect(before.memoryBytes + maskBytes + 5 * pixels).toBeGreaterThan(budgetBytes);
    const refused = command(fillRequest(large, attempted, 1)); expect(refused.ok).toBe(false); expect(refused.error).toMatch(/resource|budget|limit/i);
    expect(refused.error).toContain(`requested ${4 * pixels}`);
    const current = command({ command: 'summary' }); expect(mask()).toEqual([1, 0, 0]);
    for (const key of ['revision', 'contentRevision', 'canUndo', 'canRedo', 'toleranceSessionId', 'selectionMapBytes', 'memoryBytes'] as const)
      expect(current[key]).toEqual(before[key]);
    expect(adjustFill(id, 0).ok).toBe(true); expect(command(fillRequest(large, attempted, 1)).ok).toBe(false);
  });
  it('preserves the previous Fill amendment when retained-map pressure refuses new scratch then succeeds after release', () => {
    resetBudgetFixtureOwner();
    screenScene([[1, 2], [2, 2], [3, 2]], 7, 5, undefined, 96 * 1024);
    const original = fillMap(() => .5, undefined, 128, 48), id = nextToleranceId();
    const picked = command(fillRequest(original, id, 0)); expect(picked.ok, picked.error).toBe(true);
    const active = fillMap(() => .5, undefined, 100, 30), before = command({ command: 'summary' }), bytes = mask();
    const refused = adjustFill(id, 1); expect(refused.ok).toBe(false); expect(refused.error).toMatch(/resource|budget|limit/i);
    const current = command({ command: 'summary' }); expect(mask()).toEqual(bytes);
    for (const key of ['revision', 'contentRevision', 'canUndo', 'canRedo', 'toleranceSessionId', 'selectionMapBytes', 'memoryBytes'] as const)
      expect(current[key]).toEqual(before[key]);
    command({ command: 'selectionMapRelease', mapId: active.mapId }); expect(adjustFill(id, 1).ok).toBe(true);
  });
});
