import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { admittedNativeCommand } from './fixtures/native-export';
import { assertKsplatNative, assertKsplatPly, inspectKsplatFixture, ksplatExpectedRecord,
  ksplatHalfBits, ksplatHalfValue, KSPLAT_CASES, KSPLAT_COUNT, KSPLAT_IDS, KSPLAT_POLICY,
  KSPLAT_POLICY_ID, KSPLAT_SAMPLES, type KsplatFixture, type KsplatMeasurements } from './fixtures/ksplat-oracle';
import type { NativeSummary } from '../src/document/types';
import { wasmString, type ModuleFactory, type WasmModule } from '../src/workers/wasm';

// The constructor and the native decoder are deliberately not expected-value
// authorities. The separate pure oracle uses independent double algebra and
// binary16-grid quantization under this policy frozen before runtime execution.
const root = resolve('tests/fixtures/formats/ksplat-v1');
const fixture = (name: string) => new Uint8Array(readFileSync(resolve(root, name)));
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const NATIVE_BRANCHES = ['extra_formats.cpp', 'format_utils.hpp', 'scene_math.cpp', 'ply_export.cpp']
  .map(name => 'native/upstream/splatview/src/core/' + name);
const measurements: KsplatMeasurements = {};
let core: WasmModule, coreAbi: number | null = null;
let decoderCases = 0, scopeCases = 0, refusalCases = 0, acceptedEdgeCases = 0;
function measured(value: { measurements: KsplatMeasurements }, label: string) {
  for (const [field, sample] of Object.entries(value.measurements)) {
    const current = measurements[field] ??= { maxAbsolute: 0, maxNormalized: 0, worst: '' };
    current.maxAbsolute = Math.max(current.maxAbsolute, sample.maxAbsolute);
    if (!current.worst || sample.maxNormalized > current.maxNormalized) {
      current.maxNormalized = sample.maxNormalized; current.worst = `${label}/${sample.worst}`;
    }
  }
}
const decode = (pointer: number) => JSON.parse(core.UTF8ToString(pointer)) as NativeSummary;
function open(bytes: Uint8Array, cap = 1000) {
  const original = bytes.slice(), pointer = core._malloc(Math.max(1, bytes.length)); expect(pointer).not.toBe(0);
  try {
    core.HEAPU8.set(bytes, pointer);
    // InputFormat::Ksplat == 2; no sniffing fallback or fixture-only decoder.
    const result = decode(core._sv_open(pointer, bytes.length, 2, cap, 128 * 1024 * 1024));
    expect(bytes).toEqual(original); expect(core.HEAPU8.slice(pointer, pointer + bytes.length)).toEqual(original);
    return result;
  } finally { core._free(pointer); }
}
const command = (request: unknown) => wasmString(core, JSON.stringify(admittedNativeCommand(core, request)), pointer => decode(core._sv_command(pointer)));
const sceneBytes = (count = KSPLAT_COUNT) => core.HEAPU8.slice(core._sv_scene_ptr(), core._sv_scene_ptr() + count * 144);
const maskBytes = (count = KSPLAT_COUNT) => core.HEAPU8.slice(core._sv_states_ptr(), core._sv_states_ptr() + count);
const outputBytes = () => core.HEAPU8.slice(core._sv_output_ptr(), core._sv_output_ptr() + core._sv_output_len());
function exported(scope: number) {
  const result = command({ command: 'export', format: 0, scope }); expect(result.ok, result.error).toBe(true); return outputBytes();
}
function checkNative(sample: KsplatFixture, ids: readonly number[], label: string) {
  const bytes = sceneBytes(ids.length); measured(assertKsplatNative(bytes, sample, ids, label), label);
  // GPU records omit native covariance padding; active SH halves are padded
  // only to a whole uint32. The included padding half retains native RUB bits.
  const stride = 40 + 4 * Math.ceil(3 * (sample.degree + 1) ** 2 / 2), pointer = core._sv_pack(0, ids.length);
  expect(pointer).not.toBe(0); expect(core._sv_pack_len()).toBe(ids.length * stride);
  const packed = core.HEAPU8.slice(pointer, pointer + ids.length * stride);
  ids.forEach((_id, row) => {
    expect(packed.slice(row * stride, row * stride + 40)).toEqual(bytes.slice(row * 144, row * 144 + 40));
    expect(packed.slice(row * stride + 40, (row + 1) * stride)).toEqual(bytes.slice(row * 144 + 48, row * 144 + 48 + stride - 40));
  });
}
function checkExport(sample: KsplatFixture, ids: readonly number[], scope: number, label: string, translationX = 0) {
  measured(assertKsplatPly(exported(scope), sample, ids, { translationX }), label);
}
function editSelected(ids: readonly number[]) {
  ids.forEach((id, index) => {
    const selected = command({ command: 'single', index: id, operation: index ? 1 : 0 });
    expect(selected.ok, selected.error).toBe(true); expect(selected.selected).toBe(index + 1);
  });
}
function settled(request: unknown) {
  let result = command(request);
  for (let i = 0; result.pending && i < 16; i++) result = decode(core._sv_step(65536));
  expect(result.ok, result.error).toBe(true); expect(result.pending).toBe(false); return result;
}
beforeAll(async () => {
  const url = pathToFileURL(resolve('public/wasm/splatview-core.mjs')).href;
  const factory = (await import(/* @vite-ignore */ url) as { default: ModuleFactory }).default;
  core = await factory({ locateFile(name: string) {
    if (name !== 'splatview-core.wasm') throw new Error('Unexpected native artifact request.');
    return resolve('public/wasm/splatview-core.wasm');
  } });
  coreAbi = core._sv_abi_version();
  expect(coreAbi).toBe(24);
  expect(JSON.parse(core.UTF8ToString(core._sv_build_identity()))).toMatchObject({ abi: 24, capabilities: { selectionMorphology: 2 } });
});
afterAll(() => process.stdout.write('SPLATVIEW_KSPLAT_CALIBRATION ' + JSON.stringify({ policyId: KSPLAT_POLICY_ID, coreAbi,
  fixtureCases: KSPLAT_CASES.length, decoderCases, scopeCases, refusalCases, acceptedEdgeCases, measurements }) + '\n'));

describe('independent KSPLAT original input inventory and analytic anchors', () => {
  it('binds exactly thirteen input files, physical sections, poisoned reserve and frozen native branches', () => {
    const manifest = JSON.parse(new TextDecoder().decode(fixture('manifest.json'))) as {
      schemaVersion: number; packet: string; policyId: string; policies: Record<string, unknown>;
      construction: string; constructionSha256: string;
      sourceLock: { path: string; sha256: string; package: string; treeSha256: string };
      nativeBranches: { path: string; bytes: number; sha256: string }[];
      inputs: { file: string; bytes: number; sha256: string; mode: number; retainedDegree: number; sourceCount: number;
        encoding: string; sectionCount: number; totalCapacity: number; headerBytes: number; sectionHeaderBytes: number;
        payloadOffset: number; minSh: number; maxSh: number; effectiveMinSh: number; effectiveMaxSh: number;
        cap3SourceIds: number[]; cap2SourceIds: number[]; cap1SourceIds: number[]; sections: Record<string, unknown>[] }[];
    };
    expect(manifest).toMatchObject({ schemaVersion: 1, packet: 'ksplat-v1', policyId: KSPLAT_POLICY_ID,
      construction: 'tools/formats/build-ksplat-v1.mjs', policies: KSPLAT_POLICY });
    expect(sha(readFileSync(manifest.construction))).toBe(manifest.constructionSha256);
    expect(manifest.sourceLock).toMatchObject({ path: 'native/SOURCE_LOCK.json', package: 'splatview',
      treeSha256: 'f0b272ebe75f0c8380610e4c242faab76e3922f7494cf675d679c9d8dad37e61' });
    const lockBytes = readFileSync(manifest.sourceLock.path), lock = JSON.parse(lockBytes.toString('utf8')) as {
      packages: { splatview: { treeSha256: string } }; files: { path: string; sha256: string }[] };
    expect(sha(lockBytes)).toBe(manifest.sourceLock.sha256); expect(lock.packages.splatview.treeSha256).toBe(manifest.sourceLock.treeSha256);
    expect(manifest.nativeBranches.map(row => row.path)).toEqual(NATIVE_BRANCHES);
    for (const row of manifest.nativeBranches) {
      const bytes = readFileSync(row.path); expect(bytes.length).toBe(row.bytes); expect(sha(bytes)).toBe(row.sha256);
      expect(lock.files.find(item => item.path === row.path)?.sha256).toBe(row.sha256);
    }
    expect(manifest.inputs.map(row => row.file)).toEqual(KSPLAT_CASES.map(row => row.file));
    for (const [index, sample] of KSPLAT_CASES.entries()) {
      const bytes = fixture(sample.file), row = manifest.inputs[index], sections = inspectKsplatFixture(bytes, sample);
      expect(row.bytes).toBe(bytes.length); expect(row.sha256).toBe(sha(bytes));
      expect(row).toMatchObject({ mode: sample.mode, sourceCount: 263, retainedDegree: sample.degree, encoding: 'binary_little_endian',
        sectionCount: sample.mixed ? 6 : 4, totalCapacity: sample.mixed ? 278 : 272, headerBytes: 4096, sectionHeaderBytes: 1024,
        payloadOffset: 4096 + sections.length * 1024, minSh: sample.mixed ? 0 : -.75, maxSh: sample.mixed ? 0 : 1.25,
        effectiveMinSh: sample.mixed ? -1.5 : -.75, effectiveMaxSh: sample.mixed ? 1.5 : 1.25,
        cap3SourceIds: [87, 175, 262], cap2SourceIds: [131, 262], cap1SourceIds: [262] });
      expect(row.sections).toHaveLength(sections.length);
      sections.forEach((section, i) => expect(row.sections[i]).toMatchObject({ ...section, range: 4096, blockSize: 16, bucketBytes: 12, reservedCount: section.capacity - section.count }));
    }
  });
  it('anchors half ties, covariance parity and full sampling ordinals without a native-derived oracle', () => {
    expect([ksplatHalfBits(0), ksplatHalfBits(-0), ksplatHalfBits(1), ksplatHalfBits(-1.5),
      ksplatHalfBits(1 + 2 ** -11), ksplatHalfBits(1 + 3 * 2 ** -11)]).toEqual([0, 0x8000, 0x3c00, 0xbe00, 0x3c00, 0x3c02]);
    expect(ksplatHalfValue(0x8000)).toBe(-0); expect(ksplatHalfValue(1)).toBe(2 ** -24);
    const expected = ksplatExpectedRecord({ mode: 0, degree: 3 }, 0);
    expect(expected.position).toEqual([32 - 15 / 512, 8 - 8 / 512, -16 - 1 / 512]);
    expect(expected.rgba).toEqual([0, 17, 29, 0]); expect(expected.quaternion).toEqual([2, 1, 0, 0]);
    expect(Math.abs(expected.covarianceRub[4] - .0225)).toBeLessThan(1e-16); expect(expected.sh[3]).toBe(.125);
    const turned = ksplatExpectedRecord({ mode: 0, degree: 3 }, 1);
    expect(turned.covarianceRdf[2]).toBeLessThan(0); expect(turned.covarianceRub[2]).toBe(-turned.covarianceRdf[2]);
    expect(KSPLAT_SAMPLES.slice(1).map(row => row.ids)).toEqual([[87, 175, 262], [131, 262], [262]]);
    expect(KSPLAT_IDS.filter(id => (Math.floor((id + 1) * 3 / 263) - Math.floor(id * 3 / 263)) !== 0)).toEqual([87, 175, 262]);
  });
});

for (const sample of KSPLAT_CASES) {
  for (const load of KSPLAT_SAMPLES) it(`${sample.file}: cap${load.cap} independently decodes all ${load.ids.length} canonical and GPU records`, () => {
    const result = open(fixture(sample.file), load.cap); expect(result.ok, result.error).toBe(true);
    expect(result).toMatchObject({ kind: 0, format: 'KSPLAT', loaded: true, sourceCount: 263, count: load.ids.length,
      shDegree: sample.degree, selected: 0, visible: load.ids.length, yUp: true });
    checkNative(sample, load.ids, `${sample.file}/cap${load.cap}`);
    checkExport(sample, load.ids, 0, `${sample.file}/cap${load.cap}`); decoderCases++;
  });
  it(`${sample.file}: PLY scopes and deletion preserve independent section/bucket-edge source attributes`, () => {
    expect(open(fixture(sample.file)).ok).toBe(true);
    const selected = [0, 1, 2, 3, 4, 5, 6, 52, 53, 68, 69, 70, 102, 134, 135, 166, 167, 262];
    editSelected(selected);
    expect(Array.from(maskBytes(), value => Boolean(value & 1))).toEqual(KSPLAT_IDS.map(id => selected.includes(id)));
    checkExport(sample, KSPLAT_IDS, 0, `${sample.file}/all`); checkExport(sample, selected, 1, `${sample.file}/selected`);
    const remainder = KSPLAT_IDS.filter(id => !selected.includes(id)); checkExport(sample, remainder, 2, `${sample.file}/remainder`);
    const before = sceneBytes(), beforeMasks = maskBytes(), removed = command({ command: 'delete' });
    expect(removed.ok, removed.error).toBe(true); expect(removed.visible).toBe(remainder.length);
    expect(Array.from(maskBytes(), value => Boolean(value & 2))).toEqual(KSPLAT_IDS.map(id => selected.includes(id)));
    checkExport(sample, remainder, 0, `${sample.file}/deleted`);
    expect(command({ command: 'undo' }).visible).toBe(263); expect(maskBytes()).toEqual(beforeMasks); expect(sceneBytes()).toEqual(before);
    expect(command({ command: 'redo' }).visible).toBe(remainder.length); checkExport(sample, remainder, 0, `${sample.file}/redo`);
    expect(command({ command: 'undo' }).canRedo).toBe(true); expect(maskBytes()).toEqual(beforeMasks); expect(sceneBytes()).toEqual(before); scopeCases++;
  });
}

const BASE = KSPLAT_CASES.find(row => row.file === 'mode2-sh3.ksplat')!;
function changed(change: (view: DataView, sections: ReturnType<typeof inspectKsplatFixture>, bytes: Uint8Array) => void, sample = BASE) {
  const bytes = fixture(sample.file), sections = inspectKsplatFixture(bytes, sample);
  change(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), sections, bytes); return bytes;
}
function preserveRefusal(bytes: Uint8Array, cap = 1000) {
  expect(open(fixture(BASE.file)).ok).toBe(true);
  settled({ command: 'transform', matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, .125, 0, 0, 1], selectedOnly: false });
  editSelected([2, 5, 69, 262]); expect(command({ command: 'delete' }).visible).toBe(259); expect(command({ command: 'undo' }).canRedo).toBe(true);
  const previousOutput = exported(0), before = command({ command: 'summary' }), previousScene = sceneBytes(), previousMasks = maskBytes();
  const pointers = [core._sv_scene_ptr(), core._sv_states_ptr(), core._sv_output_ptr(), core._sv_output_len()];
  const result = open(bytes, cap); expect(result.ok).toBe(false); expect(result.error).toBeTruthy();
  const after = command({ command: 'summary' });
  for (const name of ['count', 'sourceCount', 'kind', 'format', 'shDegree', 'selected', 'visible', 'revision', 'contentRevision',
    'canUndo', 'canRedo', 'memoryBytes', 'exportBytes', 'exportOutputBytes', 'camera', 'center', 'radius', 'yUp', 'alignment', 'floor'] as const)
    expect(after[name], name).toEqual(before[name]);
  expect([core._sv_scene_ptr(), core._sv_states_ptr(), core._sv_output_ptr(), core._sv_output_len()]).toEqual(pointers);
  expect(sceneBytes()).toEqual(previousScene); expect(maskBytes()).toEqual(previousMasks); expect(outputBytes()).toEqual(previousOutput);
  const redone = command({ command: 'redo' }); expect(redone.ok, redone.error).toBe(true); expect(redone.visible).toBe(259); expect(redone.canRedo).toBe(false);
  expect(Array.from(maskBytes(), value => Boolean(value & 2))).toEqual(KSPLAT_IDS.map(id => [2, 5, 69, 262].includes(id)));
  checkExport(BASE, KSPLAT_IDS.filter(id => ![2, 5, 69, 262].includes(id)), 0, 'refusal/old-owner-redo', .125);
  expect(command({ command: 'undo' }).canRedo).toBe(true); expect(sceneBytes()).toEqual(previousScene); expect(maskBytes()).toEqual(previousMasks);
  expect(exported(0)).toEqual(previousOutput); refusalCases++;
}
type Mutation = [string, Parameters<typeof changed>[0]];
const HEADER_REFUSALS: Mutation[] = [
  ['major version', view => view.setUint8(0, 1)], ['minor version', view => view.setUint8(1, 2)],
  ['zero source count', view => view.setUint32(16, 0, true)], ['source count above ten million', view => view.setUint32(16, 10_000_001, true)],
  ['zero sections', view => view.setUint32(4, 0, true)], ['too many sections', view => view.setUint32(4, 65537, true)],
  ['section table exceeds file', view => view.setUint32(4, 64, true)], ['unsupported mode', view => view.setUint16(20, 3, true)],
  ['nonfinite minimum SH', view => view.setFloat32(36, NaN, true)], ['nonfinite maximum SH', view => view.setFloat32(40, Infinity, true)],
  ['reversed SH bounds', view => view.setFloat32(36, 2, true)],
  ['section degree4', (view, s) => view.setUint16(s[1].headerOffset + 40, 4, true)],
  ['section count exceeds capacity', (view, s) => view.setUint32(s[1].headerOffset, 9, true)],
  ['section count exceeds total', (view, s) => { view.setUint32(s[1].headerOffset, 264, true); view.setUint32(s[1].headerOffset + 4, 264, true); }],
  ['capacity storage exceeds payload', (view, s) => view.setUint32(s[1].headerOffset + 4, 0xffffffff, true)],
  ['compressed zero bucket size', (view, s) => view.setUint32(s[1].headerOffset + 8, 0, true)],
  ['compressed wrong bucket bytes', (view, s) => view.setUint16(s[1].headerOffset + 20, 11, true)],
  ['bucket count exceeds live records', (view, s) => view.setUint32(s[1].headerOffset + 12, 6, true)],
  ['full bucket capacity exceeds count', (view, s) => view.setUint32(s[1].headerOffset + 32, 3, true)],
  ['full plus partial bucket count mismatch', (view, s) => view.setUint32(s[1].headerOffset + 32, 0, true)],
  ['zero block size', (view, s) => view.setFloat32(s[1].headerOffset + 16, 0, true)],
  ['negative block size', (view, s) => view.setFloat32(s[1].headerOffset + 16, -16, true)],
  ['nonfinite block size', (view, s) => view.setFloat32(s[1].headerOffset + 16, NaN, true)],
  ['range exceeds uint16', (view, s) => view.setUint32(s[1].headerOffset + 24, 65536, true)],
  ['zero partial length', (view, s) => view.setUint32(s[1].partialLengthsOffset, 0, true)],
  ['partial length exceeds bucket size', (view, s) => view.setUint32(s[1].partialLengthsOffset, 3, true)],
  ['partial coverage too small', (view, s) => view.setUint32(s[1].partialLengthsOffset + 4, 1, true)],
  ['partial coverage exceeds section', (view, s) => view.setUint32(s[1].partialLengthsOffset, 2, true)],
  ['header count disagrees with complete sections', view => view.setUint32(16, 264, true)],
];
describe('source-reachable KSPLAT malformed input preserves the edited owner and executable Redo', () => {
  for (const [name, change] of HEADER_REFUSALS) it(`${name}: complete refusal transaction`, () => preserveRefusal(changed(change)));
  for (const end of [0, 4095, 8191]) it(`truncation at byte${end}: complete refusal transaction`, () => preserveRefusal(fixture(BASE.file).subarray(0, end)));
  for (const index of [0, 1, 2, 3]) it(`section${index} capacity payload truncation: complete refusal transaction`, () => {
    const bytes = fixture(BASE.file), section = inspectKsplatFixture(bytes, BASE)[index];
    preserveRefusal(bytes.subarray(0, section.payloadOffset + section.storageBytes - 1));
  });
  // The late 'missing bucket' branch is unreachable after the validated complete
  // positive full/partial coverage; exercise its real header prerequisites above.
  for (const sample of [KSPLAT_CASES[3], KSPLAT_CASES[7], BASE]) {
    it(`${sample.file}: a retained nonfinite scale refuses while an unsampled invalid record stays unparsed`, () => {
      const bytes = changed((view, sections) => sample.mode === 0 ? view.setFloat32(sections[1].dataOffset + 12, NaN, true)
        : view.setUint16(sections[1].dataOffset + 6, 0x7e00, true), sample);
      preserveRefusal(bytes); expect(open(bytes, 1).ok).toBe(true); checkNative(sample, [262], `${sample.file}/unsampled-invalid-scale`); acceptedEdgeCases++;
    });
    it(`${sample.file}: retained zero quaternion refuses with old-scene/output/history preservation`, () => {
      preserveRefusal(changed((_view, sections, bytes) => bytes.fill(0, sections[1].dataOffset + (sample.mode === 0 ? 24 : 12),
        sections[1].dataOffset + (sample.mode === 0 ? 40 : 20)), sample));
    });
  }
});
describe('KSPLAT preserved boundary semantics with independent expected attributes', () => {
  for (const range of [[0, 0], [0, 1.25], [-.75, 0], [.375, .375]] as const) it(`raw SH range${range.join('/')} preserves default/equal range policy`, () => {
    const bytes = changed(view => { view.setFloat32(36, range[0], true); view.setFloat32(40, range[1], true); });
    const sample = { ...BASE, minSh: range[0], maxSh: range[1] };
    expect(open(bytes).ok).toBe(true); checkNative(sample, KSPLAT_IDS, 'accepted-SH-range'); checkExport(sample, KSPLAT_IDS, 0, 'accepted-SH-range'); acceptedEdgeCases++;
  });
  it('zero compressed position ranges use32767 without changing the stored uint16 position codes', () => {
    const bytes = changed((view, sections) => sections.forEach(section => view.setUint32(section.headerOffset + 24, 0, true)));
    const sample = { ...BASE, positionRange: 0 };
    expect(open(bytes).ok).toBe(true); checkNative(sample, KSPLAT_IDS, 'default-position-range'); checkExport(sample, KSPLAT_IDS, 0, 'default-position-range'); acceptedEdgeCases++;
  });
  it('mode0 retains its float positions while unused spatial validation fields are zero', () => {
    const sample = KSPLAT_CASES[3], bytes = changed((view, sections) => sections.forEach(section => {
      view.setUint32(section.headerOffset + 8, 0, true); view.setFloat32(section.headerOffset + 16, 0, true);
    }), sample);
    expect(open(bytes).ok).toBe(true); checkNative(sample, KSPLAT_IDS, 'mode0-spatial-fields-unused'); checkExport(sample, KSPLAT_IDS, 0, 'mode0-spatial-fields-unused'); acceptedEdgeCases++;
  });
  it('empty degree3 reserved sections do not increase the retained degree of nonempty SH0', () => {
    const sample = KSPLAT_CASES[8], result = open(fixture(sample.file)); expect(result.ok).toBe(true); expect(result.shDegree).toBe(0);
    checkNative(sample, KSPLAT_IDS, 'empty-high-degree'); checkExport(sample, KSPLAT_IDS, 0, 'empty-high-degree'); acceptedEdgeCases++;
  });
  it('trailing bytes remain outside all declared capacity spans', () => {
    const bytes = new Uint8Array(Buffer.concat([fixture(BASE.file), Buffer.from([0xde, 0xad, 0xbe, 0xef])]));
    expect(open(bytes).ok).toBe(true); checkNative(BASE, KSPLAT_IDS, 'trailing'); acceptedEdgeCases++;
  });
});
