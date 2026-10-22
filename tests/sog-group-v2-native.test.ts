import { admittedNativeCommand } from './fixtures/native-export';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ResourceLedger } from '../src/document/resources';
import { BUILD_DESCRIPTOR } from '../src/generated/buildIdentity';
import type { NativeSummary } from '../src/document/types';
import { validateFloorSummary } from '../src/document/floorProtocol';
import { validateAlignmentSummary } from '../src/document/alignmentProtocol';
import { GROUP_NATIVE_BUDGET_BYTES, GROUP_NATIVE_WORK_BYTES, groupWorkerBytes, validateGroupSourceFingerprint } from '../src/document/sourceGroup';
import { finishSourceFingerprint } from '../src/io/fingerprint';
import { stageGroupSourceInput } from '../src/workers/groupSourceInput';
import { wasmString, type ModuleFactory, type WasmModule } from '../src/workers/wasm';
import { groupFixture, independentGroupKey } from './fixtures/group-source';
import { prepareSogGroup } from '../src/io/sogGroup';
import oracle from './fixtures/sog-group-v2/expected-records.json';
import vectors from './fixtures/sog-group-v2/source-key-vectors.json';

// Actual published codec/core + independently fixed Decimal80/literal RGBA
// expectations. The source-count, attributes and tolerances are not generated
// by this decoder, exporter, staging helper or a native numerical test double.
let core: WasmModule;
const maxima = new Map<string, number>();
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const fixtureBytes = (name: string) => new Uint8Array(readFileSync(resolve('tests/fixtures/sog-group-v2', name)));
async function changedOriginalMetadata(change: (text: string) => string) {
  const baseline = await groupFixture(undefined, 2), ledger = new ResourceLedger(128 * 1024 * 1024);
  try {
    const files = baseline.group.descriptor.resources.map(resource => new File([
      resource.role === 'primary' ? change(new TextDecoder().decode(baseline.bytes.get(resource.resourceId)!)) :
        new Uint8Array(baseline.bytes.get(resource.resourceId)!),
    ], resource.path));
    const group = await prepareSogGroup(files, { admit: bytes => ledger.reserve('source', bytes), current() {} });
    const bytes = new Map(await Promise.all(group.sources.map(async resource =>
      [resource.resourceId, new Uint8Array(await resource.blob.arrayBuffer())] as const)));
    return { group, bytes, ledger, dispose() { group.dispose(); expect(ledger.usage.bytes).toBe(0); } };
  } finally { baseline.dispose(); }
}
function decode(pointer: number): NativeSummary {
  const value = JSON.parse(core.UTF8ToString(pointer)) as NativeSummary;
  if (value.ok) {
    value.floor = validateFloorSummary(value.floor, { loadedCount: value.count, pending: value.pending });
    expect(validateAlignmentSummary(value.alignment)).not.toBeNull();
  } else expect(typeof value.error).toBe('string');
  return value;
}
const command = (value: unknown) => wasmString(core, JSON.stringify(admittedNativeCommand(core, value)), pointer => decode(core._sv_command(pointer)));
function close(actual: number, expected: number, bound: number, field: string) {
  expect(Number.isFinite(actual), field).toBe(true); const error = Math.abs(actual - expected);
  maxima.set(field.split('/')[0], Math.max(maxima.get(field.split('/')[0]) ?? 0, error / bound));
  expect(error, `${field}: ${actual} vs ${expected}, fixed bound ${bound}`).toBeLessThanOrEqual(bound);
}
const expectedHalf = new Map<number, number>();
function halfBits(expected: number) {
  if (expectedHalf.has(expected)) return expectedHalf.get(expected)!;
  for (let bits = 0; bits < 0x10000; bits++) {
    const exponent = bits >>> 10 & 31, fraction = bits & 1023;
    if (exponent === 31) continue;
    const decoded = (bits & 0x8000 ? -1 : 1) * (exponent === 0 ? 2 ** -14 * fraction / 1024 : 2 ** (exponent - 15) * (1 + fraction / 1024));
    if (Object.is(decoded, expected)) { expectedHalf.set(expected, bits); return bits; }
  }
  throw new Error('The independent oracle DC must be an exact finite half value.');
}
function records(count: number) {
  const pointer = core._sv_scene_ptr(), view = new DataView(core.HEAPU8.buffer);
  return Array.from({ length: count }, (_, row) => ({
    fields: Array.from({ length: 12 }, (_, index) => view.getFloat32(pointer + row * 144 + index * 4, true)),
    half: Array.from({ length: 48 }, (_, index) => view.getUint16(pointer + row * 144 + 48 + index * 2, true)) }));
}
function checkRecords(ids: readonly number[]) {
  const rows = records(ids.length), policy = oracle.numericPolicy;
  const packedPointer = core._sv_pack(0, ids.length), packedLength = core._sv_pack_len();
  expect(packedLength).toBe(ids.length * 48); const packed = new DataView(core.HEAPU8.buffer, packedPointer, packedLength);
  ids.forEach((id, row) => {
    const expected = oracle.records[id], actual = rows[row];
    expected.positionRub.forEach((value, axis) => close(actual.fields[axis], value, policy.positionsAbsolute, `position/${id}/${axis}`));
    close(actual.fields[3], expected.opacity, policy.opacityAbsolute, `opacity/${id}`);
    const native = new DataView(core.HEAPU8.buffer, core._sv_scene_ptr() + row * 144, 144);
    expect(native.getUint32(12, true)).toBe(expected.opacityFloat32Bits);
    expect(Array.from({ length: 24 }, (_, index) => native.getUint32(48 + 4 * index, true))).toEqual(expected.packedShWords);
    const variance = Math.max(...expected.linearScales.map(value => value * value));
    expected.covarianceRub.forEach((value, index) => close(actual.fields[4 + index], value,
      policy.covarianceRelativeToMaxAxisVariance * variance, `covariance/${id}/${index}`));
    expect(actual.fields.slice(10)).toEqual([0, 0]);
    expect(actual.half.slice(0, 3)).toEqual(expected.packedDcHalf.map(halfBits));
    expect(actual.half.slice(3)).toEqual(expected.absentShHalfBits);
    expect(Array.from({ length: 10 }, (_, index) => packed.getFloat32(row * 48 + 4 * index, true))).toEqual(actual.fields.slice(0, 10));
    expect(Array.from({ length: 3 }, (_, index) => packed.getUint16(row * 48 + 40 + index * 2, true))).toEqual(expected.packedDcHalf.map(halfBits));
  });
  return rows;
}
function output(format = 0, scope = 0) {
  const value = command({ command: 'export', format, scope }); expect(value.ok, value.error).toBe(true);
  return core.HEAPU8.slice(core._sv_output_ptr(), core._sv_output_ptr() + core._sv_output_len());
}
function exportedIds(ids: readonly number[], scope: number) {
  const bytes = output(2, scope), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(bytes.length).toBe(ids.length * 32);
  ids.forEach((id, row) => oracle.records[id].positionRdf.forEach((value, axis) =>
    close(view.getFloat32(32 * row + 4 * axis, true), value, oracle.numericPolicy.positionsAbsolute, `export-position/${id}/${axis}`)));
}
function snapshot() {
  const summary = command({ command: 'summary' });
  return { summary, scenePointer: core._sv_scene_ptr(), maskPointer: core._sv_states_ptr(),
    bytes: core.HEAPU8.slice(core._sv_scene_ptr(), core._sv_scene_ptr() + 144 * summary.count),
    masks: core.HEAPU8.slice(core._sv_states_ptr(), core._sv_states_ptr() + summary.count) };
}
async function openGroup(source: Awaited<ReturnType<typeof groupFixture>>, cap = 3) {
  const descriptor = source.group.descriptor, ledger = new ResourceLedger(groupWorkerBytes(descriptor));
  const untouched = new Map([...source.bytes].map(([id, bytes]) => [id, bytes.slice()]));
  const reads: string[] = [];
  const staged = await stageGroupSourceInput(core, descriptor, { current: () => source.group.assertCurrent(),
    admit: bytes => ledger.reserve('source', bytes), async read(id, offset, length) {
      reads.push(id); const bytes = source.bytes.get(id)!.slice(offset, offset + length).buffer; let live = true;
      return { bytes, consume() { expect(live).toBe(true); live = false; }, release() { live = false; } };
    } });
  try {
    const beforeBlock = core.HEAPU8.slice(staged.pointer, staged.pointer + staged.byteLength);
    const beforeDescriptor = core.HEAPU8.slice(staged.descriptorPointer, staged.descriptorPointer + staged.descriptorByteLength);
    const summary = decode(core._sv_open_group(staged.pointer, staged.byteLength, staged.descriptorPointer,
      staged.descriptorByteLength, cap, GROUP_NATIVE_BUDGET_BYTES, GROUP_NATIVE_WORK_BYTES));
    expect(summary.ok, summary.error).toBe(true); expect(summary.sourceCount).toBe(staged.sourceCount);
    expect(core.HEAPU8.slice(staged.pointer, staged.pointer + staged.byteLength)).toEqual(beforeBlock);
    expect(core.HEAPU8.slice(staged.descriptorPointer, staged.descriptorPointer + staged.descriptorByteLength)).toEqual(beforeDescriptor);
    for (const [id, original] of untouched) expect(source.bytes.get(id), id).toEqual(original);
    const fingerprint = validateGroupSourceFingerprint(finishSourceFingerprint(staged.summary, staged.assetDigest, summary.format), descriptor, summary);
    const result = { summary, fingerprint, reads };
    staged.dispose(); expect(() => staged.pointer).toThrow(/disposed/); expect(() => staged.descriptorPointer).toThrow(/disposed/);
    expect(ledger.usage.bytes).toBe(0); return result;
  } finally { staged.dispose(); }
}
function openBundle() {
  const bytes = fixtureBytes('bundled-v2-sh0.sog'), pointer = core._malloc(bytes.length); expect(pointer).not.toBe(0);
  try { core.HEAPU8.set(bytes, pointer); return decode(core._sv_open(pointer, bytes.length, 3, 100, 128 * 1024 * 1024)); }
  finally { core._free(pointer); }
}
/** Intentional raw C ABI refusal inputs. Worker staging independently rejects
 * altered rewrites; these exercise native version/SH/codec/budget guards. */
function rawRefusal(source: Awaited<ReturnType<typeof groupFixture>>, kind: string) {
  const descriptor = source.group.descriptor;
  let rewritten = source.bytes.get(descriptor.decoder.resourceId)!.slice();
  const parts = descriptor.resources.map(resource => source.bytes.get(resource.resourceId)!.slice());
  if (kind === 'version3' || kind === 'malformed-SH' || kind === 'indexed-scale-overflow' ||
      kind === 'indexed-DC-overflow' || kind === 'missing-index' || kind === 'empty-codebook' || kind === 'oversized-codebook') {
    const meta = JSON.parse(new TextDecoder().decode(rewritten));
    if (kind === 'version3') meta.version = 3;
    else if (kind === 'malformed-SH') meta.shN = { bands: 1, count: 64, codebook: [0], files: ['r0000.webp', 'r0000.webp'] };
    else if (kind === 'indexed-scale-overflow') meta.scales.codebook[0] = 1e100;
    else if (kind === 'indexed-DC-overflow') meta.sh0.codebook[0] = 1e100;
    else if (kind === 'missing-index') meta.scales.codebook = [0];
    else if (kind === 'empty-codebook') meta.scales.codebook = [];
    else meta.scales.codebook = Array(257).fill(0);
    rewritten = new TextEncoder().encode(JSON.stringify(meta));
  } else if (kind === 'truncated-WebP') {
    const index = descriptor.resources.findIndex(resource => resource.path === 'positions-low.webp'); parts[index] = parts[index].slice(0, 12);
  }
  const block = new Uint8Array(Buffer.concat([...parts, rewritten]));
  const header = new Uint8Array(20 + 4 * (parts.length - 1)), view = new DataView(header.buffer);
  [0x47535653, 1, parts.length - 1, parts[0].length, rewritten.length, ...parts.slice(1).map(bytes => bytes.length)]
    .forEach((value, index) => view.setUint32(4 * index, value, true));
  const pointer = core._malloc(block.length), table = core._malloc(header.length); expect(pointer).not.toBe(0); expect(table).not.toBe(0);
  try {
    core.HEAPU8.set(block, pointer); core.HEAPU8.set(header, table);
    const result = decode(core._sv_open_group(pointer, block.length, table, header.length, 100,
      kind === 'budget' ? 64 : GROUP_NATIVE_BUDGET_BYTES, kind === 'zero-headroom' ? 0 : GROUP_NATIVE_WORK_BYTES));
    expect(core.HEAPU8.slice(pointer, pointer + block.length)).toEqual(block); expect(core.HEAPU8.slice(table, table + header.length)).toEqual(header);
    return result;
  } finally { core._free(table); core._free(pointer); }
}
beforeAll(async () => {
  const factory = (await import(/* @vite-ignore */ pathToFileURL(resolve('public/wasm/splatview-core.mjs')).href) as { default: ModuleFactory }).default;
  core = await factory({ locateFile(name: string) { if (name !== 'splatview-core.wasm') throw new Error('Unexpected native artifact request.');
    return resolve('public/wasm/splatview-core.wasm'); } });
  expect(BUILD_DESCRIPTOR.protocolVersion).toBe(28); expect(BUILD_DESCRIPTOR.uiWorkerContract).toBe(23);
  expect(core._sv_abi_version()).toBe(24); expect(BUILD_DESCRIPTOR.native.core.abi).toBe(24);
  expect(BUILD_DESCRIPTOR.native.core.capabilities.transactionReceipt).toBe(2);
  expect(BUILD_DESCRIPTOR.native.core.capabilities.recoveryCheckpoint).toBe(2);
  expect(BUILD_DESCRIPTOR.native.core.capabilities.absoluteOpacitySession).toBe(1);
  expect(BUILD_DESCRIPTOR.native.core.capabilities.opacityBaseStream).toBe(1);
  expect(BUILD_DESCRIPTOR.native.core.capabilities.proTransformSession).toBe(2);
  expect(BUILD_DESCRIPTOR.native.camera.capabilities.cameraTransformGizmo).toBe(1);
  expect(BUILD_DESCRIPTOR.native.core.capabilities.groupedSog).toBe(3); expect(typeof core._sv_open_group).toBe('function');
});
afterAll(() => process.stdout.write('Grouped SOG fixed-policy normalized error maxima: ' + JSON.stringify(Object.fromEntries(maxima)) + '\n'));

describe('actual published grouped v2 SH0 SOG source calibration', () => {
  it('binds the independent literal records and original-group key vectors before numerical comparison', () => {
    expect(sha(fixtureBytes('expected-records.json'))).toBe('fa7316db72e081c58d4637f2b3ccce4b2c8ee21ec1830cfb169425f0878da52b');
    expect(sha(fixtureBytes('source-key-vectors.json'))).toBe('73569e2db922807914f7820b404e5f6a264ba57e0684ef302e970a30641069a5');
    expect(oracle.numericPolicy.id).toBe('sog-v2-sh0-small-v1'); expect(oracle.sourceCount).toBe(3); expect(oracle.shDegree).toBe(0);
  });
  it('accepts truncated v2 version/count conversions while hashing exact fractional original metadata', async () => {
    const source = await changedOriginalMetadata(text => text.replace(/"version":\s*2/, value => value + '.9')
      .replace(/"count":\s*3/, value => value + '.9'));
    try {
      expect(source.group.version).toBe(2); expect(source.group.sourceCount).toBe(3);
      const actual = await openGroup(source); expect(actual.summary.format).toBe('SOG v2'); checkRecords(oracle.allSourceIds);
      expect(actual.fingerprint.assetDigest).toBe(independentGroupKey(source.group.descriptor, source.bytes));
      expect(actual.fingerprint.assetDigest).toBe(vectors.vectors.find(vector => vector.name === 'fractional-version-and-count-truncate-to-v2-three')!.assetDigest);
      const original = JSON.parse(new TextDecoder().decode(source.bytes.get(source.group.descriptor.resourceId)!));
      expect(original).toMatchObject({ version: 2.9, count: 3.9 });
    } finally { source.dispose(); }
  });
  for (const [cap, ids] of [[3, oracle.allSourceIds], [2, oracle.cap2SourceIds], [1, oracle.cap1SourceIds]] as const)
    it(`decodes group at cap${cap} with exact source membership and independent attributes after input disposal`, async () => {
      const source = await groupFixture(undefined, 2);
      try {
        const value = await openGroup(source, cap);
        expect(value.summary).toMatchObject({ loaded: true, kind: 0, format: 'SOG v2', count: ids.length, sourceCount: 3, shDegree: 0, yUp: true, floor: null });
        expect(value.fingerprint.assetDigest).toBe(vectors.vectors[0].assetDigest);
        expect(value.fingerprint).toMatchObject({ totalBytes: vectors.vectors[0].totalBytes, resourceCount: 6 });
        checkRecords(ids); exportedIds(ids, 0); expect(snapshot().masks).toEqual(new Uint8Array(ids.length));
        expect(value.reads).toEqual([...source.group.descriptor.resources, source.group.descriptor.decoder].map(resource => resource.resourceId));
        const appearance = source.group.descriptor.resources.filter(resource => resource.path === 'appearance.webp'); expect(appearance).toHaveLength(1);
        const rewritten = JSON.parse(new TextDecoder().decode(source.bytes.get(source.group.descriptor.decoder.resourceId)!));
        expect(rewritten.scales.files[0]).toBe(rewritten.sh0.files[0]);
        expect(value.reads.filter(id => id === appearance[0].resourceId)).toHaveLength(1);
      } finally { source.dispose(); }
    });
  it('agrees with the bundled baseline while both independently match the literal source oracle', async () => {
    const source = await groupFixture(undefined, 2);
    try {
      await openGroup(source); const grouped = checkRecords(oracle.allSourceIds), groupOutput = output();
      expect(openBundle().ok).toBe(true); checkRecords(oracle.allSourceIds);
      expect(records(3)).toEqual(grouped); expect(output()).toEqual(groupOutput);
    } finally { source.dispose(); }
  });
  it('changes the original key for a declared unused-extra mutation while decoded attributes remain identical', async () => {
    const original = await groupFixture(undefined, 2);
    const extra = fixtureBytes('collection/asset/declared-extra.bin'); extra[extra.length - 1] = 33;
    const changed = await groupFixture(extra, 2);
    try {
      const baseline = await openGroup(original), before = checkRecords(oracle.allSourceIds), after = await openGroup(changed);
      expect(after.fingerprint.assetDigest).toBe(vectors.vectors.find(vector => vector.name === 'declared-extra-last-byte-changed')!.assetDigest);
      expect(after.fingerprint.assetDigest).not.toBe(baseline.fingerprint.assetDigest); expect(records(3)).toEqual(before); checkRecords(oracle.allSourceIds);
    } finally { original.dispose(); changed.dispose(); }
  });
  it('admits a zero-byte declared unused extra without losing it from source identity or changing attributes', async () => {
    const source = await groupFixture(new Uint8Array(), 2);
    try {
      const value = await openGroup(source), extra = source.group.descriptor.resources.find(resource => resource.path === 'declared-extra.bin')!;
      expect(extra.byteLength).toBe(0); expect(value.reads).not.toContain(extra.resourceId);
      expect(value.fingerprint).toMatchObject({ resourceCount: 6, totalBytes: source.group.descriptor.byteLength }); checkRecords(oracle.allSourceIds);
    } finally { source.dispose(); }
  });
  for (const kind of ['version3', 'malformed-SH', 'truncated-WebP', 'budget', 'zero-headroom',
    'indexed-scale-overflow', 'indexed-DC-overflow', 'missing-index', 'empty-codebook', 'oversized-codebook'])
    it(`refuses raw grouped ${kind} while retaining edited source bytes, masks, exports and executable Undo/Redo`, async () => {
      const source = await groupFixture(undefined, 2);
      try {
        await openGroup(source); expect(command({ command: 'single', index: 1 }).selected).toBe(1);
        expect(command({ command: 'delete' }).visible).toBe(2); expect(command({ command: 'undo' }).canRedo).toBe(true);
        const all = output(), selected = output(2, 1);
        // Diagnostic exports retain native output storage; include that owner
        // in the complete baseline before attempting the refused replacement.
        const before = snapshot();
        const refusal = rawRefusal(source, kind); expect(refusal.ok).toBe(false); expect(refusal.error).toBeTruthy();
        expect(snapshot()).toEqual(before); expect(output()).toEqual(all); expect(output(2, 1)).toEqual(selected); checkRecords(oracle.allSourceIds);
        expect(command({ command: 'redo' }).visible).toBe(2); exportedIds([0, 2], 0);
        expect(Array.from(snapshot().masks, value => (value & 2) !== 0)).toEqual([false, true, false]);
        expect(command({ command: 'undo' }).canRedo).toBe(true); expect(snapshot().bytes).toEqual(before.bytes); expect(snapshot().masks).toEqual(before.masks);
      } finally { source.dispose(); }
    });
});
