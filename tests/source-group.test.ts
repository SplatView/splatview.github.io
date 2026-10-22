import { describe, expect, it } from 'vitest';
import { groupBlockBytes, groupDecodeAdmissionBytes, groupDescriptorBytes, groupNativeStageBytes,
  groupStageBytes, groupTransferBytes, groupWorkerBytes, validateGroupSourceDescriptor,
  validateGroupSourceFingerprint, type GroupSourceDescriptor } from '../src/document/sourceGroup';
import { assertSceneInputBytes, assertSourceFitsDecodeBudget, MAX_INPUT_BYTES,
  MAX_SOURCE_TRANSPORT_BYTES, NATIVE_LOAD_BUDGET_BYTES } from '../src/document/sceneInputLimits';
import { validateSourceDescriptor } from '../src/document/source';
import type { NativeSummary } from '../src/document/types';

function packet(): GroupSourceDescriptor {
  return { kind: 'group', operationId: 'open', resourceId: 'metadata', byteLength: 16,
    path: 'meta.json', role: 'primary', resources: [
      { resourceId: 'metadata', byteLength: 8, path: 'meta.json', role: 'primary' },
      { resourceId: 'image', byteLength: 8, path: 'a.webp', role: 'referenced' },
      { resourceId: 'extra', byteLength: 0, path: 'extra.bin', role: 'referenced' },
    ], decoder: { resourceId: 'decoder', byteLength: 12 } };
}
function summary(): NativeSummary {
  return { ok: true, duplicateRange: null, loaded: true, count: 3, sourceCount: 3, shDegree: 0, format: 'SOG v1', kind: 0,
    selected: 0, visible: 3, canUndo: false, canRedo: false, revision: 0, contentRevision: 0,
    transaction: false, selectionDraft: false, sceneChanged: false, pending: false, progress: 1,
    center: [0, 0, 0], radius: 1, yUp: true, camera: [0, 0, 0, 0, 0, 0, 1, 45, 1, 0, 1],
    memoryBytes: 432, selectionMapId: null, pendingSelectionMapId: null, selectionMapBytes: 0,
    selectionMapRetainedIds: [], floor: null, filter: null, transformSession: null, opacitySession: null };
}
const fingerprint = () => ({ scheme: 'splatview-source-v1', assetDigest: 'a'.repeat(64), resourceCount: 3,
  totalBytes: 16, sourceKindHint: 'SOG v1' });

describe('group original identity and native staging contract', () => {
  it('detaches a canonical original union including an empty declared extra', () => {
    const source = packet(), accepted = validateGroupSourceDescriptor(source);
    (source.resources[1] as { path: string }).path = 'mutated.webp';
    expect(accepted.resources[1].path).toBe('a.webp'); expect(Object.isFrozen(accepted.resources)).toBe(true);
    expect(accepted.byteLength).toBe(16); expect(groupBlockBytes(accepted)).toBe(28);
    expect(groupTransferBytes(accepted)).toBe(28); expect(groupDescriptorBytes(accepted)).toBe(28);
    expect(groupNativeStageBytes(accepted)).toBe(56);
    expect(groupStageBytes(accepted)).toBeGreaterThan(groupNativeStageBytes(accepted));
    expect(groupWorkerBytes(accepted) - groupStageBytes(accepted)).toBe(28);
  });
  it('keeps uint32 transport representation separate from source decode admission without allocating source bodies', () => {
    expect(MAX_SOURCE_TRANSPORT_BYTES).toBe(0xffff_ffff); expect(MAX_INPUT_BYTES).toBe(MAX_SOURCE_TRANSPORT_BYTES);
    expect(NATIVE_LOAD_BUDGET_BYTES).toBe(512 * 1024 * 1024);
    expect(() => assertSceneInputBytes(MAX_SOURCE_TRANSPORT_BYTES)).not.toThrow();
    expect(() => assertSceneInputBytes(MAX_SOURCE_TRANSPORT_BYTES + 1)).toThrow('The scene source exceeds the 32-bit input transport limit.');
    const single = { kind: 'single', operationId: 'open', resourceId: 'source', byteLength: MAX_SOURCE_TRANSPORT_BYTES,
      path: '', role: 'primary' };
    expect(validateSourceDescriptor(single).byteLength).toBe(MAX_SOURCE_TRANSPORT_BYTES);
    expect(() => validateSourceDescriptor({ ...single, byteLength: MAX_SOURCE_TRANSPORT_BYTES + 1 })).toThrow('Invalid source descriptor.');
    const source = packet(); (source.resources[1] as { byteLength: number }).byteLength = MAX_INPUT_BYTES - 8;
    (source as { byteLength: number }).byteLength = MAX_INPUT_BYTES;
    expect(validateGroupSourceDescriptor(source).byteLength).toBe(MAX_INPUT_BYTES);
    expect(groupBlockBytes(source)).toBe(MAX_INPUT_BYTES + 12);
    expect(() => assertSourceFitsDecodeBudget(groupNativeStageBytes(source), NATIVE_LOAD_BUDGET_BYTES)).toThrow(/decode memory budget/);
    (source.resources[1] as { byteLength: number }).byteLength++; (source as { byteLength: number }).byteLength++;
    expect(() => validateGroupSourceDescriptor(source)).toThrow(/identity/);
  });
  it('removes the former 256 MiB product cap while requiring space beyond the complete source allocation', () => {
    expect(() => assertSourceFitsDecodeBudget(256 * 1024 * 1024 + 1, NATIVE_LOAD_BUDGET_BYTES)).not.toThrow();
    expect(() => assertSourceFitsDecodeBudget(NATIVE_LOAD_BUDGET_BYTES - 1, NATIVE_LOAD_BUDGET_BYTES)).not.toThrow();
    for (const sourceBytes of [NATIVE_LOAD_BUDGET_BYTES, NATIVE_LOAD_BUDGET_BYTES + 1])
      expect(() => assertSourceFitsDecodeBudget(sourceBytes, NATIVE_LOAD_BUDGET_BYTES))
        .toThrow('The scene source does not fit within the available decode memory budget.');
    for (const sourceBytes of [-1, NaN, Infinity, 1.5])
      expect(() => assertSourceFitsDecodeBudget(sourceBytes, 64)).toThrow('Invalid scene source memory size.');
    for (const budgetBytes of [0, -1, NaN, Infinity, 1.5, 0x1_0000_0000])
      expect(() => assertSourceFitsDecodeBudget(1, budgetBytes)).toThrow('Invalid scene decode memory budget.');
  });
  it('charges rewritten metadata and the native resource descriptor before grouped decode admission', () => {
    const source = packet(), descriptorBytes = 20 + 4 * (source.resources.length - 1);
    expect(groupDescriptorBytes(source)).toBe(descriptorBytes);
    const textureBytes = NATIVE_LOAD_BUDGET_BYTES - 1 - 8 - 12 - descriptorBytes;
    (source.resources[1] as { byteLength: number }).byteLength = textureBytes;
    (source as { byteLength: number }).byteLength = textureBytes + 8;
    const admitted = validateGroupSourceDescriptor(source);
    expect(groupNativeStageBytes(admitted)).toBe(NATIVE_LOAD_BUDGET_BYTES - 1);
    expect(() => groupDecodeAdmissionBytes(admitted, 3)).not.toThrow();
    (source.resources[1] as { byteLength: number }).byteLength++; (source as { byteLength: number }).byteLength++;
    expect(source.byteLength).toBeLessThan(NATIVE_LOAD_BUDGET_BYTES);
    expect(groupNativeStageBytes(source)).toBe(NATIVE_LOAD_BUDGET_BYTES);
    expect(() => groupDecodeAdmissionBytes(validateGroupSourceDescriptor(source), 3)).toThrow(/decode memory budget/);
  });
  it('keeps positive original and decoder metadata independently within16MiB', () => {
    for (const bytes of [0, 16 * 1024 * 1024 + 1, -1, NaN, 1.5]) {
      const source = packet(); (source.decoder as { byteLength: number }).byteLength = bytes;
      expect(() => validateGroupSourceDescriptor(source)).toThrow();
    }
  });
  it('refuses duplicate original or decoder identities and incorrect aggregate lengths', () => {
    for (const change of [
      (p: GroupSourceDescriptor) => { (p.resources[2] as { resourceId: string }).resourceId = 'image'; },
      (p: GroupSourceDescriptor) => { (p.decoder as { resourceId: string }).resourceId = 'metadata'; },
      (p: GroupSourceDescriptor) => { (p as { byteLength: number }).byteLength = 17; },
      (p: GroupSourceDescriptor) => { (p.resources[0] as { resourceId: string }).resourceId = 'other'; },
    ]) { const source = packet(); change(source); expect(() => validateGroupSourceDescriptor(source)).toThrow(); }
  });
  it('refuses path aliases, traversal, URLs, literal backslashes and noncanonical resource order', () => {
    for (const path of ['../image.webp', '/image.webp', 'https://host/image.webp', 'dir\\image.webp', 'a.webp', 'A.WEBP', 'meta.json']) {
      const source = packet(); (source.resources[2] as { path: string }).path = path;
      expect(() => validateGroupSourceDescriptor(source)).toThrow();
    }
    const source = packet(); (source.resources[2] as { path: string }).path = '0.webp';
    expect(() => validateGroupSourceDescriptor(source)).toThrow(/order/);
  });
  it('detaches a nested primary path and canonical nested references without collapsing their identity paths', () => {
    const source = packet();
    (source as { path: string }).path = 'scene/Meta.JSON';
    (source.resources[0] as { path: string }).path = source.path;
    (source.resources[1] as { path: string }).path = 'scene/texture/a.webp';
    (source.resources[2] as { path: string }).path = 'shared/extra.bin';
    const accepted = validateGroupSourceDescriptor(source);
    expect(accepted.path).toBe('scene/Meta.JSON');
    expect(accepted.resources.map(item => item.path)).toEqual(['scene/Meta.JSON', 'scene/texture/a.webp', 'shared/extra.bin']);
    for (const path of ['scene/other.json', 'scene/meta.json']) {
      const changed = { ...source, path };
      expect(() => validateGroupSourceDescriptor(changed)).toThrow(/metadata/);
    }
  });
  it.each([
    ['SCENE/a.webp', 'scene/extra.bin'],
    ['scene/DIR/a.webp', 'scene/dir/extra.bin'],
    ['scene/A.WEBP/extra.bin', 'scene/a.webp'],
  ])('refuses case-aliased path components in %s and %s', (image, extra) => {
    const source = packet(); (source as { path: string }).path = 'scene/meta.json';
    (source.resources[0] as { path: string }).path = source.path;
    (source.resources[1] as { path: string }).path = image;
    (source.resources[2] as { path: string }).path = extra;
    expect(() => validateGroupSourceDescriptor(source)).toThrow(/case-alias/);
  });
  it('does not invoke getter-backed wire fields or accept sparse resource tables', () => {
    const source = packet(); let calls = 0;
    Object.defineProperty(source, 'decoder', { enumerable: true, get() { calls++; throw new Error('Getter ran'); } });
    expect(() => validateGroupSourceDescriptor(source)).toThrow(/data/); expect(calls).toBe(0);
    const sparse = packet(); delete (sparse.resources as unknown[])[1];
    expect(() => validateGroupSourceDescriptor(sparse)).toThrow();
  });
  it('rejects over40 resources and publishes no accidental ordinary-file identity', () => {
    const source = packet();
    (source.resources as unknown[]).push(...Array.from({ length: 39 }, (_, index) => ({ resourceId: `r${index}`,
      path: `z${index.toString().padStart(2, '0')}.webp`, role: 'referenced', byteLength: 0 })));
    expect(() => validateGroupSourceDescriptor(source)).toThrow(/length/);
    expect(() => validateGroupSourceFingerprint({ ...fingerprint(), resourceCount: 1 }, packet(), summary())).toThrow();
  });
  it('excludes decoder transfer bytes from the complete original fingerprint', () => {
    expect(validateGroupSourceFingerprint(fingerprint(), packet(), summary()).totalBytes).toBe(16);
    expect(() => validateGroupSourceFingerprint({ ...fingerprint(), totalBytes: 28 }, packet(), summary())).toThrow();
  });
  it('requires a settled fresh Gaussian SH0–3 decode with finite view and retained-owner metadata', () => {
    for (const change of [
      { kind: 1 }, { shDegree: 4 }, { count: 1_000_001 }, { sourceCount: 10_000_001 },
      { pending: true }, { canRedo: true }, { selectionDraft: true }, { selected: 1 },
      { radius: Infinity }, { memoryBytes: -1 }, { camera: [0] }, { center: [NaN, 0, 0] },
      { selectionMapRetainedIds: [1] }, { contentRevision: NaN },
    ]) expect(() => validateGroupSourceFingerprint(fingerprint(), packet(), { ...summary(), ...change } as NativeSummary)).toThrow();
  });
  it.each([0, 1, 2, 3] as const)('binds a known parsed SH%i exactly while unhinted clients accept every valid integer degree', degree => {
    const value = { ...summary(), shDegree: degree };
    expect(validateGroupSourceFingerprint(fingerprint(), packet(), value).totalBytes).toBe(16);
    expect(validateGroupSourceFingerprint(fingerprint(), packet(), value, degree).totalBytes).toBe(16);
    expect(() => validateGroupSourceFingerprint(fingerprint(), packet(), value, degree === 0 ? 1 : 0)).toThrow(/fingerprint/);
  });
  it.each([1, 2, 3] as const)('allows a texture-derived legacy SH%i for the authenticated unknown nonzero hint', degree => {
    expect(validateGroupSourceFingerprint(fingerprint(), packet(), { ...summary(), shDegree: degree }, null).resourceCount).toBe(3);
  });
  it('refuses a zero legacy degree and noninteger/coerced/out-of-range native degrees before publishing an identity', () => {
    expect(() => validateGroupSourceFingerprint(fingerprint(), packet(), summary(), null)).toThrow(/fingerprint/);
    for (const degree of [-1, 4, 1.5, NaN, Infinity, true, '1', null]) {
      expect(() => validateGroupSourceFingerprint(fingerprint(), packet(), { ...summary(), shDegree: degree } as NativeSummary)).toThrow();
      expect(() => validateGroupSourceFingerprint(fingerprint(), packet(), summary(), degree as 0)).toThrow();
    }
  });
  it('accounts the native input once while provisioning native peak plus GPU workspace', () => {
    const source = packet(), base = groupDecodeAdmissionBytes(source, 3);
    const larger = packet(); (larger as { byteLength: number }).byteLength += 100;
    (larger.resources[1] as { byteLength: number }).byteLength += 100;
    expect(groupDecodeAdmissionBytes(larger, 3)).toBe(base - 100);
    expect(() => groupDecodeAdmissionBytes(source, 0)).toThrow();
    expect(() => groupDecodeAdmissionBytes(source, 1_000_001)).toThrow();
  });
  it('adds the packed SH buffer widths to the existing admission without recharging native records or source staging', () => {
    const source = packet(), count = 100, sh0 = groupDecodeAdmissionBytes(source, count);
    // Packed records occupy48/64/96/136 bytes for SH0/1/2/3. Native records
    // remain144 bytes; their grant and the unchanged input must not grow twice.
    expect([0, 1, 2, 3].map(degree => groupDecodeAdmissionBytes(source, count, degree as 0) - sh0)).toEqual([0, 1600, 4800, 8800]);
    for (const degree of [-1, 4, 1.5, NaN, Infinity, true, '1', null])
      expect(() => groupDecodeAdmissionBytes(source, count, degree as 0)).toThrow(/SH admission/);
  });
});
