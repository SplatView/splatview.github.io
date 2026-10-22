import { admittedNativeCommand } from './fixtures/native-export';
import { beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BUILD_DESCRIPTOR } from '../src/generated/buildIdentity';
import { nativeModuleIdentity } from '../src/build/native';
import { ResourceLedger, packedStride } from '../src/document/resources';
import { GROUP_NATIVE_BUDGET_BYTES, GROUP_NATIVE_WORK_BYTES, groupWorkerBytes, validateGroupSourceFingerprint } from '../src/document/sourceGroup';
import type { NativeSummary } from '../src/document/types';
import { finishSourceFingerprint } from '../src/io/fingerprint';
import { prepareSceneCollection } from '../src/io/sceneCollection';
import { prepareSogCollectionGroup } from '../src/io/sogGroup';
import { stageGroupSourceInput } from '../src/workers/groupSourceInput';
import { wasmString, type ModuleFactory, type WasmModule } from '../src/workers/wasm';
import { independentGroupKey } from './fixtures/group-source';
import vector from './fixtures/scene-collection-nested-v1/expected-source-key.json';
import manifest from './fixtures/scene-collection-nested-v1/manifest.json';
import oracle from './fixtures/sog-group-sh/packets/v2-sh3/expected-records.json';

// Actual published native codec/hash/packing, calibrated against independent
// path framing and unchanged independently authored full48-half numeric goldens.
let core: WasmModule;
const root = 'tests/fixtures/scene-collection-nested-v1';
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const bytes = (path: string) => new Uint8Array(readFileSync(resolve(root, path)));
function result(pointer: number) { return JSON.parse(core.UTF8ToString(pointer)) as NativeSummary; }
const command = (value: unknown) => wasmString(core, JSON.stringify(admittedNativeCommand(core, value)), pointer => result(core._sv_command(pointer)));
function records(count: number) { return core.HEAPU8.slice(core._sv_scene_ptr(), core._sv_scene_ptr() + count * 144); }
function masks(count: number) { return core.HEAPU8.slice(core._sv_states_ptr(), core._sv_states_ptr() + count); }
function exported() {
  expect(command({ command: 'export', format: 0, scope: 0 }).ok).toBe(true);
  return core.HEAPU8.slice(core._sv_output_ptr(), core._sv_output_ptr() + core._sv_output_len());
}
async function prepared(prefix = '', changed?: ReadonlyMap<string, Uint8Array>) {
  const ledger = new ResourceLedger(128 * 1024 * 1024), acquisitions: string[] = [];
  const collection = prepareSceneCollection(manifest.files.filter(file => file.path.startsWith('collection/')).map(file => {
    const relative = file.path.slice('collection/'.length), name = relative.slice(relative.lastIndexOf('/') + 1);
    const body = changed?.get(relative) ?? bytes(file.path);
    return { path: prefix + relative, kind: 'file' as const, async getFile() {
      acquisitions.push(relative); return new File([body.slice()], name);
    } };
  }), { admit: count => ledger.reserve('source', count), current() {} });
  try {
    const group = await prepareSogCollectionGroup(collection, prefix + vector.primaryPath,
      { admit: count => ledger.reserve('source', count), current() {} });
    const originals = new Map(await Promise.all(group.sources.map(async source =>
      [source.resourceId, new Uint8Array(await source.blob.arrayBuffer())] as const)));
    return { group, originals, ledger, acquisitions, async dispose() {
      group.dispose(); await collection.dispose(); expect(ledger.usage.bytes).toBe(0);
    } };
  } catch (error) { await collection.dispose(); expect(ledger.usage.bytes).toBe(0); throw error; }
}
async function open(source: Awaited<ReturnType<typeof prepared>>, cap: number) {
  const descriptor = source.group.descriptor, ledger = new ResourceLedger(groupWorkerBytes(descriptor));
  const staged = await stageGroupSourceInput(core, descriptor, { current: () => source.group.assertCurrent(),
    admit: count => ledger.reserve('source', count), async read(id, offset, length) {
      let live = true;
      return { bytes: source.originals.get(id)!.slice(offset, offset + length).buffer,
        consume() { expect(live).toBe(true); live = false; }, release() { live = false; } };
    } });
  try {
    const block = core.HEAPU8.slice(staged.pointer, staged.pointer + staged.byteLength);
    const table = core.HEAPU8.slice(staged.descriptorPointer, staged.descriptorPointer + staged.descriptorByteLength);
    const summary = result(core._sv_open_group(staged.pointer, staged.byteLength, staged.descriptorPointer,
      staged.descriptorByteLength, cap, GROUP_NATIVE_BUDGET_BYTES, GROUP_NATIVE_WORK_BYTES));
    expect(summary.ok, summary.error).toBe(true);
    expect(summary).toMatchObject({ count: cap, sourceCount: 3, shDegree: 3, format: 'SOG v2' });
    expect(core.HEAPU8.slice(staged.pointer, staged.pointer + staged.byteLength)).toEqual(block);
    expect(core.HEAPU8.slice(staged.descriptorPointer, staged.descriptorPointer + staged.descriptorByteLength)).toEqual(table);
    const fingerprint = validateGroupSourceFingerprint(finishSourceFingerprint(staged.summary, staged.assetDigest,
      summary.format), descriptor, summary, staged.shDegree);
    return { summary, fingerprint };
  } finally { staged.dispose(); expect(ledger.usage.bytes).toBe(0); }
}
function calibrated(ids: readonly number[]) {
  const native = new DataView(core.HEAPU8.buffer, core._sv_scene_ptr(), ids.length * 144), stride = packedStride(3);
  const pointer = core._sv_pack(0, ids.length); expect(core._sv_pack_len()).toBe(ids.length * stride);
  const packed = new DataView(core.HEAPU8.buffer, pointer, ids.length * stride);
  ids.forEach((id, row) => {
    const literal = oracle.records[id], offset = row * 144, policy = oracle.numericPolicy;
    literal.positionRub.forEach((value, axis) => expect(Math.abs(native.getFloat32(offset + axis * 4, true) - value)).toBeLessThanOrEqual(policy.positionsAbsolute));
    expect(Math.abs(native.getFloat32(offset + 12, true) - literal.opacity)).toBeLessThanOrEqual(policy.opacityAbsolute);
    const variance = Math.max(...literal.linearScales.map(value => value * value));
    literal.covarianceRub.forEach((value, axis) => expect(Math.abs(native.getFloat32(offset + 16 + axis * 4, true) - value))
      .toBeLessThanOrEqual(variance * policy.covarianceRelativeToMaxAxisVariance));
    expect(Array.from({ length: 48 }, (_, half) => native.getUint16(offset + 48 + half * 2, true))).toEqual(literal.packedShHalfBits);
    expect(Array.from({ length: 48 }, (_, half) => packed.getUint16(row * stride + 40 + half * 2, true))).toEqual(literal.packedShHalfBits);
    expect(Array.from({ length: 10 }, (_, field) => packed.getFloat32(row * stride + field * 4, true)))
      .toEqual(Array.from({ length: 10 }, (_, field) => native.getFloat32(offset + field * 4, true)));
  });
}
beforeAll(async () => {
  const factory = (await import(/* @vite-ignore */ pathToFileURL(resolve('public/wasm/splatview-core.mjs')).href) as { default: ModuleFactory }).default;
  core = await factory({ locateFile(name: string) {
    if (name !== 'splatview-core.wasm') throw new Error('Unexpected actual native artifact.');
    return resolve('public/wasm/splatview-core.wasm');
  } });
  expect(BUILD_DESCRIPTOR.protocolVersion).toBe(28); expect(BUILD_DESCRIPTOR.uiWorkerContract).toBe(23);
  expect(core._sv_abi_version()).toBe(24); expect(BUILD_DESCRIPTOR.native.core.abi).toBe(24);
  expect(BUILD_DESCRIPTOR.native.core.capabilities.transactionReceipt).toBe(2);
  expect(BUILD_DESCRIPTOR.native.core.capabilities.recoveryCheckpoint).toBe(2);
  expect(BUILD_DESCRIPTOR.native.core.capabilities.absoluteOpacitySession).toBe(1);
  expect(BUILD_DESCRIPTOR.native.core.capabilities.opacityBaseStream).toBe(1);
  expect(BUILD_DESCRIPTOR.native.core.capabilities.proTransformSession).toBe(2);
  expect(BUILD_DESCRIPTOR.native.camera.capabilities.cameraTransformGizmo).toBe(1);
  nativeModuleIdentity(core, BUILD_DESCRIPTOR.native.core);
});
describe('actual published nested selected-collection original-key and SH3 calibration', () => {
  it('binds every original fixture, independent framing and unchanged numeric oracle', () => {
    for (const file of manifest.files) expect({ bytes: bytes(file.path).length, sha256: sha(bytes(file.path)) }).toEqual({ bytes: file.bytes, sha256: file.sha256 });
    const golden = new Uint8Array(readFileSync(vector.numericOracle.path)); expect(sha(golden)).toBe(vector.numericOracle.sha256);
    expect(sha(Uint8Array.from(Buffer.from(vector.canonicalHex, 'hex')))).toBe(vector.assetDigest);
  });
  for (const cap of [3, 2, 1]) it(`uppercase primary and shared-parent references calibrate actual full48/native packed SH at cap${cap}`, async () => {
    const source = await prepared();
    try {
      const actual = await open(source, cap);
      expect(actual.fingerprint).toMatchObject({ assetDigest: vector.assetDigest, resourceCount: 8, totalBytes: vector.totalBytes });
      expect(source.group.descriptor.path).toBe(vector.primaryPath);
      expect(source.acquisitions).toHaveLength(8); expect(source.acquisitions).not.toContain('private/unrelated-neighbor.bin');
      calibrated(cap === 3 ? oracle.allSourceIds : cap === 2 ? oracle.cap2SourceIds : oracle.cap1SourceIds);
    } finally { await source.dispose(); }
  });
  it('outer selected-root renaming preserves actual complete group key and native records', async () => {
    const first = await prepared(), renamed = await prepared('renamed-outer/');
    try {
      expect((await open(first, 3)).fingerprint.assetDigest).toBe(vector.assetDigest); const before = records(3);
      expect((await open(renamed, 3)).fingerprint.assetDigest).toBe(vector.assetDigest); expect(records(3)).toEqual(before); calibrated(oracle.allSourceIds);
    } finally { await first.dispose(); await renamed.dispose(); }
  });
  it('the aliased declared unused original changes the actual key without changing decoded native records', async () => {
    const body = bytes('collection/shared/declared-extra.bin'); body[body.length - 1] ^= 85;
    const first = await prepared(), changed = await prepared('', new Map([['shared/declared-extra.bin', body]]));
    try {
      await open(first, 3); const before = records(3), actual = await open(changed, 3);
      expect(actual.fingerprint.assetDigest).not.toBe(vector.assetDigest);
      expect(actual.fingerprint.assetDigest).toBe(independentGroupKey(changed.group.descriptor, changed.originals));
      expect(actual.fingerprint.resourceCount).toBe(8); expect(actual.fingerprint.totalBytes).toBe(vector.totalBytes);
      expect(records(3)).toEqual(before); calibrated(oracle.allSourceIds);
    } finally { await first.dispose(); await changed.dispose(); }
  });
  it('an escaping selected metadata reference refuses before replacement and retains actual edited masks/export/Redo', async () => {
    const source = await prepared();
    try {
      await open(source, 3); expect(command({ command: 'single', index: 1 }).selected).toBe(1);
      expect(command({ command: 'delete' }).visible).toBe(2); expect(command({ command: 'undo' }).canRedo).toBe(true);
      const before = records(3), state = masks(3), output = exported();
      // Snapshot the owner after its admitted diagnostic output is retained.
      const summary = command({ command: 'summary' });
      const metadata = JSON.parse(new TextDecoder().decode(bytes('collection/asset/META.JSON')));
      metadata.quats.files[0] = '../../../outside.webp';
      await expect(prepared('', new Map([[vector.primaryPath, new TextEncoder().encode(JSON.stringify(metadata))]]))).rejects.toThrow(/outside|escape|root/i);
      expect(command({ command: 'summary' })).toEqual(summary); expect(records(3)).toEqual(before); expect(masks(3)).toEqual(state); expect(exported()).toEqual(output);
      expect(command({ command: 'redo' }).visible).toBe(2); expect(command({ command: 'undo' }).canRedo).toBe(true);
      expect(records(3)).toEqual(before); expect(masks(3)).toEqual(state);
    } finally { await source.dispose(); }
  });
});
