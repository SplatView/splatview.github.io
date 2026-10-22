import { admittedNativeCommand } from './fixtures/native-export';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BUILD_DESCRIPTOR } from '../src/generated/buildIdentity';
import { nativeModuleIdentity } from '../src/build/native';
import type { NativeSummary } from '../src/document/types';
import { validateAlignmentSummary } from '../src/document/alignmentProtocol';
import { validateFloorSummary } from '../src/document/floorProtocol';
import { packedStride, ResourceLedger } from '../src/document/resources';
import { GROUP_NATIVE_BUDGET_BYTES, GROUP_NATIVE_WORK_BYTES, groupWorkerBytes, validateGroupSourceFingerprint } from '../src/document/sourceGroup';
import { finishSourceFingerprint } from '../src/io/fingerprint';
import { prepareSogGroup } from '../src/io/sogGroup';
import { stageGroupSourceInput } from '../src/workers/groupSourceInput';
import { wasmString, type ModuleFactory, type WasmModule } from '../src/workers/wasm';
import { groupShFixture, independentGroupKey } from './fixtures/group-source';
import expected from './fixtures/sog-group-sh/expected-records.json';
import vectors from './fixtures/sog-group-sh/source-key-vectors.json';
import policies from './fixtures/sog-group-sh/cases.json';

// Actual published codec/core. Active SH values, all48 binary16 components,
// base attributes and original-key bytes come from independent literal input
// construction. No decoder/export result supplies a numerical expectation.
type Packet = keyof typeof expected.packets;
type Oracle = typeof expected.packets[Packet];
type Source = Awaited<ReturnType<typeof groupShFixture>>;
type Policy = typeof policies.cases[number];
const packets = Object.keys(expected.packets) as Packet[];
const caps = [3, 2, 1] as const;
const ids = (cap: number) => cap === 3 ? [0, 1, 2] : cap === 2 ? [1, 2] : [2];
const fixture = (path: string) => new Uint8Array(readFileSync(resolve('tests/fixtures/sog-group-sh', path)));
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
let core: WasmModule;
const maxima = new Map<string, number>();

function decode(pointer: number): NativeSummary {
  const value = JSON.parse(core.UTF8ToString(pointer)) as NativeSummary;
  if (value.ok) {
    value.floor = validateFloorSummary(value.floor, { loadedCount: value.count, pending: value.pending });
    expect(validateAlignmentSummary(value.alignment)).not.toBeNull();
  } else expect(typeof value.error).toBe('string');
  return value;
}
const command = (value: unknown) => wasmString(core, JSON.stringify(admittedNativeCommand(core, value)), pointer => decode(core._sv_command(pointer)));
function close(actual: number, reference: number, bound: number, field: string) {
  expect(Number.isFinite(actual), field).toBe(true);
  const error = Math.abs(actual - reference);
  maxima.set(field.split('/')[0], Math.max(maxima.get(field.split('/')[0]) ?? 0, error / bound));
  expect(error, `${field}: ${actual} vs ${reference}; independent fixed bound ${bound}`).toBeLessThanOrEqual(bound);
}
function records(count: number) {
  const pointer = core._sv_scene_ptr(), view = new DataView(core.HEAPU8.buffer);
  return Array.from({ length: count }, (_, row) => ({
    fields: Array.from({ length: 12 }, (_, index) => view.getFloat32(pointer + row * 144 + index * 4, true)),
    half: Array.from({ length: 48 }, (_, index) => view.getUint16(pointer + row * 144 + 48 + index * 2, true)),
    words: Array.from({ length: 24 }, (_, index) => view.getUint32(pointer + row * 144 + 48 + index * 4, true)),
  }));
}
function checkRecords(oracle: Oracle, sourceIds: readonly number[]) {
  const rows = records(sourceIds.length), policy = oracle.numericPolicy;
  const stride = packedStride(oracle.shDegree), pointer = core._sv_pack(0, rows.length);
  expect(core._sv_pack_len()).toBe(rows.length * stride);
  const packed = new DataView(core.HEAPU8.buffer, pointer, rows.length * stride);
  sourceIds.forEach((id, row) => {
    const literal = oracle.records[id], actual = rows[row];
    literal.positionRub.forEach((value, axis) => close(actual.fields[axis], value, policy.positionsAbsolute, `position/${id}/${axis}`));
    close(actual.fields[3], literal.opacity, policy.opacityAbsolute, `opacity/${id}`);
    const variance = Math.max(...literal.linearScales.map(value => value * value));
    literal.covarianceRub.forEach((value, axis) => close(actual.fields[4 + axis], value,
      variance * policy.covarianceRelativeToMaxAxisVariance, `covariance/${id}/${axis}`));
    expect(actual.fields.slice(10)).toEqual([0, 0]);
    expect(actual.half).toEqual(literal.packedShHalfBits);
    expect(actual.words).toEqual(literal.packedShWords);
    expect(actual.half.slice(3, 3 + oracle.activeDirectionalHalfCount)).toEqual(literal.activeDirectionalHalfBits);
    expect(actual.half.slice(3 + oracle.activeDirectionalHalfCount)).toEqual(literal.inactiveDirectionalHalfBits);
    expect(Array.from({ length: 10 }, (_, axis) => packed.getFloat32(row * stride + axis * 4, true))).toEqual(actual.fields.slice(0, 10));
    // Native sv_pack copies whole uint32 SH words. For SH2 the28th half is
    // inactive-band parity, not an invented positive-zero GPU padding value.
    expect(Array.from({ length: (stride - 40) / 2 }, (_, component) =>
      packed.getUint16(row * stride + 40 + component * 2, true))).toEqual(literal.packedShHalfBits.slice(0, (stride - 40) / 2));
  });
  return rows;
}
function output(format = 0, scope = 0) {
  const result = command({ command: 'export', format, scope }); expect(result.ok, result.error).toBe(true);
  return core.HEAPU8.slice(core._sv_output_ptr(), core._sv_output_ptr() + core._sv_output_len());
}
function snapshot() {
  const summary = command({ command: 'summary' });
  return { summary, scenePointer: core._sv_scene_ptr(), maskPointer: core._sv_states_ptr(),
    bytes: core.HEAPU8.slice(core._sv_scene_ptr(), core._sv_scene_ptr() + summary.count * 144),
    masks: core.HEAPU8.slice(core._sv_states_ptr(), core._sv_states_ptr() + summary.count) };
}
async function openGroup(source: Source, cap: number) {
  const descriptor = source.group.descriptor, ledger = new ResourceLedger(groupWorkerBytes(descriptor));
  const original = new Map([...source.bytes].map(([id, bytes]) => [id, bytes.slice()]));
  const reads: string[] = [];
  const staged = await stageGroupSourceInput(core, descriptor, { current: () => source.group.assertCurrent(),
    admit: bytes => ledger.reserve('source', bytes), async read(id, offset, length) {
      reads.push(id); let live = true;
      return { bytes: source.bytes.get(id)!.slice(offset, offset + length).buffer,
        consume() { expect(live).toBe(true); live = false; }, release() { live = false; } };
    } });
  try {
    const beforeBlock = core.HEAPU8.slice(staged.pointer, staged.pointer + staged.byteLength);
    const beforeTable = core.HEAPU8.slice(staged.descriptorPointer, staged.descriptorPointer + staged.descriptorByteLength);
    const summary = decode(core._sv_open_group(staged.pointer, staged.byteLength, staged.descriptorPointer,
      staged.descriptorByteLength, cap, GROUP_NATIVE_BUDGET_BYTES, GROUP_NATIVE_WORK_BYTES));
    expect(summary.ok, summary.error).toBe(true); expect(summary.sourceCount).toBe(staged.sourceCount);
    expect(staged.shDegree).toBe(source.group.shDegree);
    expect(core.HEAPU8.slice(staged.pointer, staged.pointer + staged.byteLength)).toEqual(beforeBlock);
    expect(core.HEAPU8.slice(staged.descriptorPointer, staged.descriptorPointer + staged.descriptorByteLength)).toEqual(beforeTable);
    for (const [id, bytes] of original) expect(source.bytes.get(id), id).toEqual(bytes);
    const fingerprint = validateGroupSourceFingerprint(finishSourceFingerprint(staged.summary, staged.assetDigest,
      summary.format), descriptor, summary, staged.shDegree);
    staged.dispose(); expect(() => staged.pointer).toThrow(/disposed/); expect(() => staged.descriptorPointer).toThrow(/disposed/);
    expect(ledger.usage.bytes).toBe(0);
    return { summary, fingerprint, reads };
  } finally { staged.dispose(); }
}
function openBundle(packet: Packet) {
  const bytes = fixture(`packets/${packet}/bundled.sog`), pointer = core._malloc(bytes.length); expect(pointer).not.toBe(0);
  try {
    core.HEAPU8.set(bytes, pointer);
    const result = decode(core._sv_open(pointer, bytes.length, 3, 3, GROUP_NATIVE_BUDGET_BYTES));
    expect(core.HEAPU8.slice(pointer, pointer + bytes.length)).toEqual(bytes); return result;
  } finally { core._free(pointer); }
}
async function changedExtra(packet: Packet, empty = false): Promise<Source> {
  const oracle = expected.packets[packet], base = await groupShFixture(oracle.format === 'SOG v1' ? 1 : 2, oracle.shDegree as 1 | 2 | 3);
  const ledger = new ResourceLedger(128 * 1024 * 1024);
  try {
    const files = base.group.descriptor.resources.map(resource => {
      let bytes = base.bytes.get(resource.resourceId)!.slice();
      if (resource.path === 'declared-extra.bin') {
        if (empty) bytes = new Uint8Array(); else bytes[bytes.length - 1] = 33;
      }
      return new File([bytes], resource.path);
    });
    const group = await prepareSogGroup(files, { admit: bytes => ledger.reserve('source', bytes), current() {} });
    const bytes = new Map(await Promise.all(group.sources.map(async resource =>
      [resource.resourceId, new Uint8Array(await resource.blob.arrayBuffer())] as const)));
    return { group, bytes, ledger, dispose() { group.dispose(); } };
  } finally { base.dispose(); }
}
/** Deliberate raw C ABI policy inputs: malformed metadata must reach the native
 * preflight, not stop in the browser parser. Only exact filename tokens change;
 * the original numeric spelling, including -0.0, is preserved in the rewrite.
 * This helper supplies no attribute math or native candidate result. */
function rawPolicy(row: Policy, cap: number) {
  const packet = row.packet as Packet, key = vectors.packets[packet].vectors[0];
  const names = ['meta.json', ...key.resources.map(resource => resource.path).filter(path => path !== 'meta.json')];
  const bodies = names.map(name => name === 'meta.json' ? fixture(row.metadata) :
    fixture(row.resourceChanges.find(change => change.path === name)?.file ?? `packets/${packet}/collection/asset/${name}`));
  const parts: Buffer[] = [Buffer.from('SplatViewSource\0v1\0'), Buffer.from([1])], count = Buffer.alloc(4); count.writeUInt32BE(names.length); parts.push(count);
  [...names].sort().forEach(name => {
    const path = Buffer.from(name), bytes = bodies[names.indexOf(name)], framing = Buffer.alloc(5), length = Buffer.alloc(8);
    framing[0] = name === 'meta.json' ? 1 : 0; framing.writeUInt32BE(path.length, 1); length.writeBigUInt64BE(BigInt(bytes.length));
    parts.push(framing, path, length, createHash('sha256').update(bytes).digest());
  });
  expect(sha(Buffer.concat(parts))).toBe(row.sourceKey.assetDigest);
  let text = new TextDecoder().decode(bodies[0]);
  names.slice(1).forEach((name, index) => { text = text.split(JSON.stringify(name)).join(JSON.stringify(`r${String(index).padStart(4, '0')}.webp`)); });
  const rewritten = new TextEncoder().encode(text), block = new Uint8Array(Buffer.concat([...bodies, rewritten]));
  const table = new Uint8Array(20 + 4 * (names.length - 1)), view = new DataView(table.buffer);
  [0x47535653, 1, names.length - 1, bodies[0].length, rewritten.length, ...bodies.slice(1).map(body => body.length)]
    .forEach((value, index) => view.setUint32(4 * index, value, true));
  const pointer = core._malloc(block.length), descriptor = core._malloc(table.length);
  expect(pointer).not.toBe(0); expect(descriptor).not.toBe(0);
  try {
    core.HEAPU8.set(block, pointer); core.HEAPU8.set(table, descriptor);
    const result = decode(core._sv_open_group(pointer, block.length, descriptor, table.length, cap,
      GROUP_NATIVE_BUDGET_BYTES, GROUP_NATIVE_WORK_BYTES));
    expect(core.HEAPU8.slice(pointer, pointer + block.length)).toEqual(block);
    expect(core.HEAPU8.slice(descriptor, descriptor + table.length)).toEqual(table); return result;
  } finally { core._free(descriptor); core._free(pointer); }
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
  expect(BUILD_DESCRIPTOR.native.core.capabilities.groupedSog).toBe(3);
  expect(BUILD_DESCRIPTOR.native.core.capabilities.proTransformSession).toBe(2);
  expect(BUILD_DESCRIPTOR.native.camera.capabilities.cameraTransformGizmo).toBe(1);
  nativeModuleIdentity(core, BUILD_DESCRIPTOR.native.core);
});
afterAll(() => process.stdout.write('Grouped SOG higher-SH fixed-policy normalized error maxima: ' + JSON.stringify(Object.fromEntries(maxima)) + '\n'));

describe('actual published grouped SOG v1/v2 SH1Ã¢â‚¬â€œ3 independent calibration', () => {
  it('binds six independent bases, all48 half components, policy variants and original-key bytes', () => {
    expect(sha(fixture('expected-records.json'))).toBe('85bd2158a39964b0058b47382ca1ec58123b4a603d28a588649e13554d8c45a3');
    expect(sha(fixture('source-key-vectors.json'))).toBe('b62911b694cb74e04a37fbafdca51f1a60a06d0a53592c41137457d6de11723b');
    expect(packets).toHaveLength(6); expect(policies.cases).toHaveLength(33);
    for (const packet of packets) {
      const oracle = expected.packets[packet]; expect(oracle.sourceCount).toBe(3);
      expect(oracle.basisSignsCoefficients1Through15).toEqual([-1, -1, 1, -1, 1, 1, -1, 1, -1, 1, -1, -1, 1, -1, 1]);
      oracle.records.forEach(record => expect(record.packedShHalfBits).toHaveLength(48));
    }
  });
  for (const packet of packets) {
    const oracle = expected.packets[packet], version = oracle.format === 'SOG v1' ? 1 : 2;
    for (const cap of caps) it(`${packet} cap${cap} decodes every independent active SH half and inactive tail after actual staged-input retirement`, async () => {
      const source = await groupShFixture(version, oracle.shDegree as 1 | 2 | 3);
      try {
        const opened = await openGroup(source, cap), key = vectors.packets[packet].vectors[0];
        expect(opened.summary).toMatchObject({ loaded: true, kind: 0, sourceCount: 3, count: cap, shDegree: oracle.shDegree, format: oracle.format, yUp: true, floor: null });
        expect(opened.fingerprint).toMatchObject({ assetDigest: key.assetDigest, resourceCount: 8, totalBytes: key.totalBytes });
        expect(opened.fingerprint.assetDigest).toBe(independentGroupKey(source.group.descriptor, source.bytes));
        expect(source.group.shDegree).toBe(version === 1 ? null : oracle.shDegree);
        expect(opened.reads).toEqual([...source.group.descriptor.resources, source.group.descriptor.decoder].map(resource => resource.resourceId));
        const appearance = source.group.descriptor.resources.find(resource => resource.path === 'appearance.webp')!;
        expect(opened.reads.filter(id => id === appearance.resourceId)).toHaveLength(1);
        const rewrite = new TextDecoder().decode(source.bytes.get(source.group.descriptor.decoder.resourceId)!);
        expect(JSON.parse(rewrite).scales.files[0]).toBe(JSON.parse(rewrite).sh0.files[0]);
        if (version === 2) expect(rewrite).toContain('-0.0');
        checkRecords(oracle, ids(cap)); expect(snapshot().masks).toEqual(new Uint8Array(cap));
        source.dispose(); expect(source.ledger.usage.bytes).toBe(0); checkRecords(oracle, ids(cap));
      } finally { source.dispose(); }
    });
    it(`${packet} grouped and bundled inputs independently match the same active SH and base oracle`, async () => {
      const source = await groupShFixture(version, oracle.shDegree as 1 | 2 | 3);
      try {
        await openGroup(source, 3); const grouped = checkRecords(oracle, ids(3)), exported = output();
        expect(openBundle(packet).ok).toBe(true); checkRecords(oracle, ids(3));
        expect(records(3)).toEqual(grouped); expect(output()).toEqual(exported);
      } finally { source.dispose(); }
    });
    for (const empty of [false, true]) it(`${packet} ${empty ? 'empty' : 'changed'} declared extra changes the original key while allSH and decoded records remain identical`, async () => {
      const source = await changedExtra(packet, empty);
      try {
        const result = await openGroup(source, 3), key = vectors.packets[packet].vectors.find(vector =>
          vector.name === (empty ? 'declared-extra-empty' : 'declared-extra-last-byte-changed'))!;
        expect(result.fingerprint.assetDigest).toBe(key.assetDigest); expect(result.fingerprint.assetDigest).not.toBe(vectors.packets[packet].vectors[0].assetDigest);
        checkRecords(oracle, ids(3));
        if (empty) expect(result.reads).not.toContain(source.group.descriptor.resources.find(resource => resource.path === 'declared-extra.bin')!.resourceId);
      } finally { source.dispose(); }
    });
  }
  for (const row of policies.cases) it(`raw ${row.name} honors sampled source policy at caps3/2/1 and preserves edited Redo on refusal`, async () => {
    const packet = row.packet as Packet, oracle = expected.packets[packet];
    const source = await groupShFixture(oracle.format === 'SOG v1' ? 1 : 2, oracle.shDegree as 1 | 2 | 3);
    try {
      for (const cap of caps) {
        await openGroup(source, 3); expect(command({ command: 'single', index: 1 }).selected).toBe(1);
        expect(command({ command: 'delete' }).visible).toBe(2); expect(command({ command: 'undo' }).canRedo).toBe(true);
        const all = output(), selected = output(0, 1);
        // Diagnostic exports retain native output storage; include that owner
        // in the complete baseline before attempting the refused replacement.
        const before = snapshot();
        const result = rawPolicy(row, cap); expect(result.ok, result.error).toBe(row.acceptanceByCap[String(cap) as '3' | '2' | '1']);
        if (result.ok) {
          expect(result).toMatchObject({ count: cap, sourceCount: 3, shDegree: oracle.shDegree, format: oracle.format, selected: 0, canUndo: false, canRedo: false });
          const override = expected.caseOverrides[row.name as keyof typeof expected.caseOverrides];
          checkRecords(override ?? oracle, ids(cap));
        } else {
          expect(result.error).toBeTruthy(); expect(snapshot()).toEqual(before);
          expect(output()).toEqual(all); expect(output(0, 1)).toEqual(selected); checkRecords(oracle, ids(3));
          expect(command({ command: 'redo' }).visible).toBe(2);
          expect(Array.from(snapshot().masks, value => (value & 2) !== 0)).toEqual([false, true, false]);
          expect(command({ command: 'undo' }).canRedo).toBe(true);
          expect(snapshot().bytes).toEqual(before.bytes); expect(snapshot().masks).toEqual(before.masks);
        }
      }
    } finally { source.dispose(); }
  });
});
