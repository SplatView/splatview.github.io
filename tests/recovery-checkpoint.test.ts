import { createHash } from 'node:crypto';
import { deepEqual } from 'node:assert/strict';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecoveryCheckpointBuilder, PreparedRecoveryCheckpoint, RecoveryCheckpointReader, RecoveryCheckpointSnapshot,
  assertRecoveryCheckpointBinding, validateRecoveryCheckpointBinding, validateRecoveryCheckpointPlan,
  type RecoveryCheckpointBinding, type RecoveryCheckpointPlan } from '../src/document/recoveryCheckpoint';
import { MiB, ResourceLedger, estimateRecoveryCheckpointBytes } from '../src/document/resources';

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
type MutableBinding = { -readonly [Key in keyof RecoveryCheckpointBinding]: RecoveryCheckpointBinding[Key] };
function binding(): MutableBinding {
  return { version: 1,
    core: { schemaVersion: 1, kind: 'core', abi: 18, variant: 'scalar', nativeInputId: 'a'.repeat(64),
      mapLayoutVersion: 1, capabilities: { document: 1, recoveryCheckpoint: 2 } },
    source: { scheme: 'splatview-source-v1', assetDigest: 'b'.repeat(64), resourceCount: 1, totalBytes: 1024, sourceKindHint: 'PLY' },
    subset: { sourceCount: 12, loadedCount: 6, maxSplats: 6 },
    revision: { documentId: 'document-a', sourceGeneration: 2, contentRevision: 4, selectionRevision: 7, draftRevision: 0 } };
}
function fixture(byteLength = 128, normalizationFlags = 0, codecVersion = 3) {
  const bytes = new Uint8Array(byteLength);
  for (let index = 64; index < byteLength; index++) bytes[index] = (index * 19 + 7) & 255;
  const sha256 = digest(bytes.subarray(64));
  bytes.set(new TextEncoder().encode('SVCKPT01'));
  const header = new DataView(bytes.buffer);
  header.setUint32(8, codecVersion, true); header.setUint32(12, 64, true);
  header.setBigUint64(16, BigInt(byteLength), true);
  bytes.set(Uint8Array.from(sha256.match(/../g)!, pair => Number.parseInt(pair, 16)), 24);
  header.setUint32(60, normalizationFlags, true);
  const plan: RecoveryCheckpointPlan = { ok: true, version: 2, byteLength, workspaceBytes: 8192, maximumChunkBytes: 1048576,
    sceneCount: 3, maskCount: 4, normalizationFlags, actualRevision: 7, revision: 7, contentRevision: 4, nextContentRevision: 9,
    currentLoadedCount: 6, currentSourceCount: 12, currentDuplicateRange: null, maximumGraphSplats: 6,
    memoryBytes: 32768, sha256, headerSha256: digest(bytes.subarray(0, 64)) };
  return { bytes, plan };
}
const metadata = () => ({ camera: [0, 0, 1, 45], alignment: { applied: true, frame: [1, 0, 0, 1] },
  original: { resetGeneration: 1 }, geometry: null, outputReceipts: [], normalizedSessions: ['selection'] });
function builder(ledger: ResourceLedger, input = fixture(), browser: unknown = metadata()) {
  const expected = binding();
  return new RecoveryCheckpointBuilder(ledger, expected, expected, input.plan, browser);
}
async function fill(owner: RecoveryCheckpointBuilder, bytes: Uint8Array) {
  while (owner.nextRange) {
    const range = owner.nextRange!;
    await owner.append(range, bytes.slice(range.offset, range.offset + range.length).buffer);
  }
}
async function snapshot(ledger: ResourceLedger, input = fixture(), browser: unknown = metadata()) {
  const owner = builder(ledger, input, browser);
  await fill(owner, input.bytes);
  return (await owner.prepare()).accept();
}
async function readAll(owner: RecoveryCheckpointSnapshot, ledger: ResourceLedger): Promise<Uint8Array> {
  const reader = await owner.openRestore(binding(), ledger);
  const result = new Uint8Array(owner.description.plan.byteLength);
  while (reader.nextRange) {
    const chunk = await reader.read(reader.nextRange);
    result.set(new Uint8Array(chunk.bytes), chunk.offset);
    chunk.release();
  }
  await reader.finish();
  return result;
}
function holdNextDigest() {
  const realDigest = crypto.subtle.digest.bind(crypto.subtle);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (algorithm, data) => {
    entered(); await gate;
    return realDigest(algorithm, data);
  });
  return { started, release };
}
afterEach(() => vi.restoreAllMocks());

describe('external recovery checkpoint identity and admission', () => {
  it('copies and deeply freezes the exact source, native capability, subset and captured revision binding', () => {
    const input = binding(), result = validateRecoveryCheckpointBinding(input);
    expect(result).toEqual(input); expect(result).not.toBe(input);
    expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.core.capabilities)).toBe(true);
    expect(Object.isFrozen(result.revision)).toBe(true);
    input.core.capabilities.document = 99;
    (input.revision as { contentRevision: number }).contentRevision = 99;
    expect(result.core.capabilities.document).toBe(1); expect(result.revision.contentRevision).toBe(4);
  });
  it.each([
    ['native input', (value: ReturnType<typeof binding>) => { value.core = { ...value.core, nativeInputId: 'c'.repeat(64) }; }],
    ['native ABI', (value: ReturnType<typeof binding>) => { value.core = { ...value.core, abi: 19 }; }],
    ['native capability', (value: ReturnType<typeof binding>) => { value.core = { ...value.core, capabilities: { document: 2, recoveryCheckpoint: 2 } }; }],
    ['source bytes', (value: ReturnType<typeof binding>) => { value.source = { ...value.source, assetDigest: 'c'.repeat(64) }; }],
    ['source format', (value: ReturnType<typeof binding>) => { value.source = { ...value.source, sourceKindHint: 'SPZ' }; }],
    ['source resource count', (value: ReturnType<typeof binding>) => { value.source = { ...value.source, resourceCount: 2 }; }],
    ['source total length', (value: ReturnType<typeof binding>) => { value.source = { ...value.source, totalBytes: 1025 }; }],
    ['loaded count', (value: ReturnType<typeof binding>) => { value.subset = { ...value.subset, loadedCount: 5 }; }],
    ['requested subset', (value: ReturnType<typeof binding>) => { value.subset = { ...value.subset, maxSplats: 7 }; }],
    ['original count', (value: ReturnType<typeof binding>) => { value.subset = { ...value.subset, sourceCount: 13 }; }],
    ['document', (value: ReturnType<typeof binding>) => { value.revision = { ...value.revision, documentId: 'document-b' }; }],
    ['source generation', (value: ReturnType<typeof binding>) => { value.revision = { ...value.revision, sourceGeneration: 3 }; }],
    ['content revision', (value: ReturnType<typeof binding>) => { value.revision = { ...value.revision, contentRevision: 5 }; }],
    ['selection revision', (value: ReturnType<typeof binding>) => { value.revision = { ...value.revision, selectionRevision: 8 }; }],
    ['draft revision', (value: ReturnType<typeof binding>) => { value.revision = { ...value.revision, draftRevision: 1 }; }],
  ])('refuses a wrong %s before admitting a candidate or restore copy', async (_label, change) => {
    const ledger = new ResourceLedger(16 * MiB), expected = binding(), wrong = binding();
    change(wrong);
    expect(() => assertRecoveryCheckpointBinding(wrong, expected)).toThrow(/binding/);
    expect(() => new RecoveryCheckpointBuilder(ledger, expected, wrong, fixture().plan, metadata())).toThrow();
    expect(ledger.usage.bytes).toBe(0);
    const accepted = await snapshot(ledger), before = ledger.usage;
    await expect(accepted.openRestore(wrong, ledger)).rejects.toThrow(/binding/);
    expect(ledger.usage).toEqual(before);
    expect(await readAll(accepted, ledger)).toEqual(fixture().bytes);
    accepted.release(); expect(ledger.usage.bytes).toBe(0);
  });
  it('requires explicit native checkpoint capability in both supplied identities', () => {
    const expected = binding(); expected.core.capabilities.recoveryCheckpoint = 1;
    expect(() => validateRecoveryCheckpointBinding(expected)).toThrow(/capability/);
    delete expected.core.capabilities.recoveryCheckpoint;
    expect(() => validateRecoveryCheckpointBinding(expected)).toThrow(/capability/);
    expect(() => new RecoveryCheckpointBuilder(new ResourceLedger(16 * MiB), expected, expected, fixture().plan, {})).toThrow();
  });
  it.each([null, [], {}, { ...binding(), extra: 1 }, { ...binding(), version: 2 },
    { ...binding(), revision: { ...binding().revision, sourceGeneration: 0 } },
    { ...binding(), revision: { ...binding().revision, contentRevision: Number.MAX_SAFE_INTEGER + 1 } },
    { ...binding(), subset: { sourceCount: 5, loadedCount: 6, maxSplats: 6 } },
    { ...binding(), subset: { sourceCount: 12, loadedCount: 6, maxSplats: 5 } },
    { ...binding(), subset: { sourceCount: 12, loadedCount: 0, maxSplats: 6 } },
    { ...binding(), subset: { sourceCount: 12, loadedCount: 6, maxSplats: 1_000_001 } },
    { ...binding(), source: { ...binding().source, assetDigest: 'B'.repeat(64) } },
  ])('rejects malformed binding %j', value => {
    expect(() => validateRecoveryCheckpointBinding(value)).toThrow();
  });
  it('refuses accessors, hidden/symbol fields and prototype authority without invoking getters', () => {
    let invoked = 0;
    const accessor = { ...binding(), get core() { invoked++; return binding().core; } };
    const hidden = Object.defineProperty(binding(), 'extra', { value: true });
    const hiddenRequired = Object.defineProperty(binding(), 'version', { value: 1, enumerable: false });
    for (const value of [accessor, hidden, hiddenRequired, Object.create(binding()), { ...binding(), [Symbol('extra')]: 1 }])
      expect(() => validateRecoveryCheckpointBinding(value)).toThrow();
    expect(invoked).toBe(0);
  });
  it.each([
    ['byteLength', -1], ['byteLength', 63], ['byteLength', 0x8000_0000], ['workspaceBytes', Infinity],
    ['workspaceBytes', 0x1_0000_0000], ['maximumChunkBytes', MiB - 1], ['sceneCount', 0], ['maskCount', -1],
    ['normalizationFlags', 128], ['revision', Number.MAX_SAFE_INTEGER + 1], ['actualRevision', -1],
    ['contentRevision', .5], ['nextContentRevision', 3], ['sha256', 'x'.repeat(64)], ['headerSha256', 'A'.repeat(64)],
    ['memoryBytes', -1], ['ok', false], ['version', 1],
    ['currentLoadedCount', -1], ['currentLoadedCount', 1_000_001], ['currentSourceCount', 5],
    ['currentSourceCount', 0x1_0000_0000], ['maximumGraphSplats', 5], ['maximumGraphSplats', 1_000_001],
    ['currentDuplicateRange', undefined], ['currentDuplicateRange', { first: 3, count: 2 }],
  ])('refuses malformed native plan %s=%j', (field, value) => {
    const ledger = new ResourceLedger(16 * MiB);
    expect(() => new RecoveryCheckpointBuilder(ledger, binding(), binding(), { ...fixture().plan, [field]: value }, {})).toThrow();
    expect(ledger.usage.bytes).toBe(0);
  });
  it('accepts geometry maskCount zero, initial zero highwater, and native uint53 revisions', () => {
    const plan = { ...fixture().plan, maskCount: 0, actualRevision: Number.MAX_SAFE_INTEGER,
      revision: Number.MAX_SAFE_INTEGER, contentRevision: 0, nextContentRevision: 0 };
    expect(validateRecoveryCheckpointPlan(plan)).toEqual(plan);
    expect(Object.isFrozen(validateRecoveryCheckpointPlan(plan))).toBe(true);
    expect(() => validateRecoveryCheckpointPlan({ ...plan, extra: 1 })).toThrow();
  });
  it('authenticates grown topology separately from the immutable original subset', async () => {
    const ledger = new ResourceLedger(16 * MiB), input = fixture(), copied = { first: 6, count: 2 };
    input.plan = { ...input.plan, currentLoadedCount: 8, currentSourceCount: 14, currentDuplicateRange: copied, maximumGraphSplats: 8 };
    const owner = builder(ledger, input);copied.first = 0;
    await fill(owner, input.bytes);const accepted = (await owner.prepare()).accept();
    expect(accepted.description.binding.subset).toEqual({ sourceCount: 12, loadedCount: 6, maxSplats: 6 });
    expect(accepted.description.plan).toMatchObject({ currentLoadedCount: 8, currentSourceCount: 14,
      currentDuplicateRange: { first: 6, count: 2 }, maximumGraphSplats: 8 });
    expect(Object.isFrozen(accepted.description.plan.currentDuplicateRange)).toBe(true);
    expect(await readAll(accepted, ledger)).toEqual(input.bytes);
    accepted.release();expect(ledger.usage.bytes).toBe(0);
    const belowOriginal = { ...input.plan, currentDuplicateRange: { first: 6, count: 2 }, currentSourceCount: 11 };
    expect(() => new RecoveryCheckpointBuilder(ledger, binding(), binding(), belowOriginal, {})).toThrow(/source count binding/);
    expect(ledger.usage.bytes).toBe(0);
  });
  it('binds a retained graph maximum larger than current count into the owned root', async () => {
    const ledger = new ResourceLedger(16 * MiB), input = fixture();
    input.plan = { ...input.plan, maximumGraphSplats: 9 };
    const first = await snapshot(ledger, input);
    const changed = await snapshot(ledger, { ...input, plan: { ...input.plan, maximumGraphSplats: 10 } });
    expect(first.description.plan.currentLoadedCount).toBe(6);
    expect(first.description.plan.maximumGraphSplats).toBe(9);
    expect(first.description.chunks).toEqual(changed.description.chunks);
    expect(first.description.rootSha256).not.toBe(changed.description.rootSha256);
    first.release();changed.release();expect(ledger.usage.bytes).toBe(0);
  });
  it('rejects missing, accessor, prototype and signed-zero suffix authority without invoking getters', () => {
    let reads = 0;const plan = fixture().plan;
    const accessor = { get first() { reads++;return 4; }, count: 2 };
    for (const marker of [accessor, Object.create({ first: 4, count: 2 }), { first: -0, count: 6 },
      { first: 4, count: 2, contentRevision: 4 }, { first: 4, count: 0 }, { first: 7, count: 1 }])
      expect(() => validateRecoveryCheckpointPlan({ ...plan, currentDuplicateRange: marker })).toThrow();
    const { currentDuplicateRange: _missing, ...missing } = plan;
    expect(() => validateRecoveryCheckpointPlan(missing)).toThrow(/fields/);
    expect(reads).toBe(0);
  });
  it.each([
    ['undefined', undefined], ['BigInt', 1n], ['NaN', NaN], ['infinity', Infinity], ['negative zero', -0],
    ['Map', new Map()], ['typed array', new Uint8Array(4)], ['undefined property', { missing: undefined }],
    ['undefined array member', [undefined]], ['sparse array', new Array(1)], ['function property', { value: () => undefined }],
  ])('refuses non-JSON browser metadata %s', (_label, value) => {
    const ledger = new ResourceLedger(16 * MiB);
    expect(() => new RecoveryCheckpointBuilder(ledger, binding(), binding(), fixture().plan, value)).toThrow();
    expect(ledger.usage.bytes).toBe(0);
  });
  it('bounds browser metadata and cycles before payload admission', () => {
    const cycle: { next?: unknown } = {}; cycle.next = cycle;
    const deep: unknown[] = []; let tail = deep;
    for (let index = 0; index < 40; index++) { const next: unknown[] = []; tail.push(next); tail = next; }
    for (const value of [cycle, deep, 'x'.repeat(256 * 1024), { ['x'.repeat(4097)]: 1 }]) {
      const ledger = new ResourceLedger(16 * MiB);
      expect(() => builder(ledger, fixture(), value)).toThrow(); expect(ledger.usage.bytes).toBe(0);
    }
  });
  it('rejects oversized dense/sparse metadata arrays before property enumeration or descriptor copying', () => {
    const ledger = new ResourceLedger(16 * MiB), dense = new Array(1_000_000).fill(0);
    expect(() => builder(ledger, fixture(), dense)).toThrow();
    let enumerations = 0;
    const sparse = new Proxy(new Array(1_000_000), { ownKeys() { enumerations++; throw new Error('must not enumerate'); } });
    expect(() => builder(ledger, fixture(), sparse)).toThrow(/integer/);
    expect(enumerations).toBe(0); expect(ledger.usage.bytes).toBe(0);
  });
  it('reserves external retained and bounded copy/hash work, excluding native workspace from native coverage', async () => {
    const ledger = new ResourceLedger(16 * MiB), owner = builder(ledger);
    expect(ledger.usage.allocations).toBe(2); expect(ledger.usage.bytes).toBeGreaterThan(128);
    const before = ledger.usage.bytes;
    const different = new ResourceLedger(16 * MiB), nativePlan = fixture();
    nativePlan.plan = { ...nativePlan.plan, workspaceBytes: 0xffff_ffff, memoryBytes: 0xffff_ffff };
    const second = builder(different, nativePlan);
    // Different numeric metadata has a small bookkeeping cost; it never admits
    // a multi-gigabyte native heap or counts external bytes as native coverage.
    expect(Math.abs(different.usage.bytes - before)).toBeLessThan(4096);
    await second.cancel(); await owner.cancel();
    expect(ledger.usage.bytes).toBe(0); expect(different.usage.bytes).toBe(0);
  });
  it.each([[-1, MiB, 0], [0, MiB, 0], [1, 0, 0], [1, MiB + 1, 0], [1, MiB, -1],
    [Number.MAX_SAFE_INTEGER, MiB, Number.MAX_SAFE_INTEGER]])('case %#: refuses unsafe checkpoint estimate %j', (bytes, chunk, metadataBytes) => {
    expect(() => estimateRecoveryCheckpointBytes(bytes, chunk, metadataBytes)).toThrow();
  });
});

describe('immutable chunk staging, native integrity and prepared ownership', () => {
  it('roundtrips internal codec v3 with exact sequential chunks and cryptographic complete-chunk records', async () => {
    const input = fixture(MiB + 81, 4), ledger = new ResourceLedger(32 * MiB), owner = builder(ledger, input);
    expect(owner.nextRange).toEqual({ index: 0, offset: 0, length: MiB });
    await owner.append(owner.nextRange, input.bytes.slice(0, MiB).buffer);
    expect(owner.nextRange).toEqual({ index: 1, offset: MiB, length: 81 });
    await owner.append(owner.nextRange, input.bytes.slice(MiB).buffer);
    expect(owner.nextRange).toBeNull();
    const prepared = await owner.prepare(), accepted = prepared.accept();
    expect(accepted.description.plan.version).toBe(2); expect(accepted.description.binding.version).toBe(1);
    expect(accepted.description.chunks).toEqual([
      { index: 0, offset: 0, length: MiB, sha256: digest(input.bytes.subarray(0, MiB)) },
      { index: 1, offset: MiB, length: 81, sha256: digest(input.bytes.subarray(MiB)) },
    ]);
    expect(accepted.description.rootSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(accepted.description.metadataSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(ledger.usage.allocations).toBe(1);
    deepEqual(await readAll(accepted, ledger), input.bytes);
    deepEqual(await readAll(accepted, ledger), input.bytes);
    accepted.release(); expect(ledger.usage.bytes).toBe(0);
  });
  it.each([0, 1, 2, 4, 0xffff_ffff])('rejects internal codec v%i through the new plan2 path despite an exact header hash', async codecVersion => {
    const input = fixture(128, 0, codecVersion), ledger = new ResourceLedger(16 * MiB), owner = builder(ledger, input);
    expect(input.plan.version).toBe(2); expect(input.plan.headerSha256).toBe(digest(input.bytes.subarray(0,64)));
    await expect(owner.append(owner.nextRange, input.bytes.buffer)).rejects.toThrow('Invalid recovery checkpoint native codec header binding.');
    await owner.cancel(); expect(ledger.usage.bytes).toBe(0);
  });
  it.each(['header size', 'payload size', 'payload hash', 'reserved', 'normalization'] as const)(
    'internal codec v3 preserves exact %s binding even with a matching header hash', async field => {
      const input=fixture(128,4), header=new DataView(input.bytes.buffer), ledger=new ResourceLedger(16*MiB);
      if(field==='header size')header.setUint32(12,65,true);
      else if(field==='payload size')header.setBigUint64(16,129n,true);
      else if(field==='payload hash')input.bytes[24]^=1;
      else if(field==='reserved')header.setUint32(56,1,true);
      else header.setUint32(60,5,true);
      input.plan={...input.plan,headerSha256:digest(input.bytes.subarray(0,64))};
      const owner=builder(ledger,input);
      await expect(owner.append(owner.nextRange,input.bytes.buffer)).rejects.toThrow('Invalid recovery checkpoint native codec header binding.');
      await owner.cancel();expect(ledger.usage.bytes).toBe(0);
    });
  it('internal codec v3 still rejects altered header bytes when the advertised header digest is unchanged',async()=>{
    const input=fixture(), ledger=new ResourceLedger(16*MiB);
    new DataView(input.bytes.buffer).setUint32(60,4,true);input.plan={...input.plan,normalizationFlags:4};
    const owner=builder(ledger,input);
    await expect(owner.append(owner.nextRange,input.bytes.buffer)).rejects.toThrow('Invalid recovery checkpoint native header integrity.');
    await owner.cancel();expect(ledger.usage.bytes).toBe(0);
  });
  it('copies input synchronously, captures browser metadata, and never exposes the sole retained buffer', async () => {
    const ledger = new ResourceLedger(16 * MiB), input = fixture(), browser = metadata();
    const original = input.bytes.slice(), owner = builder(ledger, input, browser);
    const received = owner.append(owner.nextRange, input.bytes.buffer);
    input.bytes.fill(255); browser.camera.fill(999); browser.alignment.frame[0] = 999;
    await received;
    const accepted = (await owner.prepare()).accept();
    expect(accepted.description.metadata).toEqual(metadata());
    const reader = await accepted.openRestore(binding(), ledger), copy = await reader.read(reader.nextRange);
    new Uint8Array(copy.bytes).fill(13);
    copy.release(); expect(copy.bytes.byteLength).toBe(0);
    copy.release(); await reader.finish();
    expect(await readAll(accepted, ledger)).toEqual(original);
    expect(() => { (accepted.description.metadata as { camera: number[] }).camera[0] = 1; }).toThrow();
    expect(() => { (accepted.description.chunks as unknown[]).pop(); }).toThrow();
    expect(Object.keys(accepted)).toEqual([]);
    expect(Object.isFrozen(accepted)).toBe(true);
    accepted.release(); expect(ledger.usage.bytes).toBe(0);
  });
  it('binds the full browser metadata into a distinct root without changing equal payload chunk hashes', async () => {
    const ledger = new ResourceLedger(16 * MiB), first = await snapshot(ledger), second = await snapshot(ledger, fixture(), { ...metadata(), camera: [1, 2, 3, 4] });
    expect(first.description.chunks).toEqual(second.description.chunks);
    expect(first.description.metadataSha256).not.toBe(second.description.metadataSha256);
    expect(first.description.rootSha256).not.toBe(second.description.rootSha256);
    first.release(); second.release(); expect(ledger.usage.bytes).toBe(0);
  });
  it('keeps original accepted state charged/readable when a prepared replacement is aborted', async () => {
    const ledger = new ResourceLedger(16 * MiB), old = await snapshot(ledger), oldBytes = ledger.usage.bytes;
    const staged = builder(ledger); await fill(staged, fixture().bytes);
    const prepared = await staged.prepare();
    expect(ledger.usage.bytes).toBe(oldBytes + oldBytes);
    prepared.abort(); prepared.abort(); await staged.cancel();
    expect(ledger.usage.bytes).toBe(oldBytes);
    expect(() => prepared.accept()).toThrow(/retired/);
    expect(await readAll(old, ledger)).toEqual(fixture().bytes);
    old.release(); expect(ledger.usage.bytes).toBe(0);
  });
  it('accepts exactly once and candidate cleanup cannot retire the moved accepted owner', async () => {
    const ledger = new ResourceLedger(16 * MiB), owner = builder(ledger);
    await fill(owner, fixture().bytes); const prepared = await owner.prepare(), accepted = prepared.accept();
    const retained = ledger.usage.bytes;
    expect(() => prepared.accept()).toThrow(); prepared.abort(); await owner.cancel();
    expect(ledger.usage.bytes).toBe(retained);
    expect(await readAll(accepted, ledger)).toEqual(fixture().bytes);
    accepted.release(); accepted.release(); expect(ledger.usage.bytes).toBe(0);
  });
  it('cannot construct a prepared/snapshot/reader owner using a caller-created token', () => {
    const token = Symbol('recovery-checkpoint-owner');
    expect(() => Reflect.construct(PreparedRecoveryCheckpoint, [token, {}, {}])).toThrow(/owner/);
    expect(() => Reflect.construct(RecoveryCheckpointSnapshot, [token, {}, {}])).toThrow(/owner/);
    expect(() => Reflect.construct(RecoveryCheckpointReader, [token, {}, {}, () => undefined, () => undefined])).toThrow(/owner/);
  });
  it.each([
    { index: 1, offset: 0, length: 128 }, { index: 0, offset: 1, length: 128 }, { index: 0, offset: 0, length: 127 },
    { index: -1, offset: 0, length: 128 }, { index: .5, offset: 0, length: 128 },
    { index: '0', offset: 0, length: 128 }, { index: 0, offset: Number.MAX_SAFE_INTEGER + 1, length: 128 },
    { index: 0, offset: 0, length: Infinity }, { index: 0, offset: 0, length: 128, extra: true }, null,
  ])('refuses malformed/out-of-order range %j and preserves the current credit', async requested => {
    const ledger = new ResourceLedger(16 * MiB), owner = builder(ledger), before = ledger.usage.bytes;
    await expect(owner.append(requested, fixture().bytes.buffer)).rejects.toThrow();
    expect(ledger.usage.bytes).toBe(before);
    expect(owner.nextRange).toEqual({ index: 0, offset: 0, length: 128 });
    await owner.cancel(); expect(ledger.usage.bytes).toBe(0);
  });
  it('refuses detached, resizable, shared, viewed and forged buffers before hashing or advancing', async () => {
    const ledger = new ResourceLedger(16 * MiB), owner = builder(ledger), bytes = fixture().bytes;
    const detached = new ArrayBuffer(128); structuredClone(detached, { transfer: [detached] });
    const resizable = Reflect.construct(ArrayBuffer, [128, { maxByteLength: 256 }]);
    const values = [detached, resizable, new SharedArrayBuffer(128), bytes, bytes.subarray(1),
      new DataView(bytes.buffer), new ArrayBuffer(127), { byteLength: 128 }, new Proxy(new ArrayBuffer(128), {})];
    const spy = vi.spyOn(crypto.subtle, 'digest');
    for (const value of values) await expect(owner.append(owner.nextRange, value)).rejects.toThrow(/ArrayBuffer/);
    expect(spy).not.toHaveBeenCalled(); expect(owner.nextRange?.index).toBe(0);
    await owner.cancel(); expect(ledger.usage.bytes).toBe(0);
  });
  it('uses intrinsic ArrayBuffer length and refuses concurrent incoming credits or premature prepare', async () => {
    const ledger = new ResourceLedger(16 * MiB), input = fixture(), owner = builder(ledger), hold = holdNextDigest();
    Object.defineProperty(input.bytes.buffer, 'byteLength', { value: 9999 });
    const receiving = owner.append(owner.nextRange, input.bytes.buffer);
    await hold.started;
    await expect(owner.append(owner.nextRange, fixture().bytes.buffer)).rejects.toThrow(/outstanding/);
    await expect(owner.prepare()).rejects.toThrow(/outstanding/);
    hold.release(); await receiving;
    const prepared = await owner.prepare(); prepared.abort(); expect(ledger.usage.bytes).toBe(0);
  });
  it.each([0, 8, 12, 16, 24, 56, 60])('refuses corruption in native header byte %i and releases the failed candidate', async index => {
    const ledger = new ResourceLedger(16 * MiB), input = fixture(), owner = builder(ledger, input);
    input.bytes[index] ^= 1;
    await expect(owner.append(owner.nextRange, input.bytes.buffer)).rejects.toThrow(/header/);
    expect(ledger.usage.bytes).toBe(0); await owner.cancel(); expect(ledger.usage.bytes).toBe(0);
  });
  it('refuses an independently mismatched native header hash', async () => {
    const ledger = new ResourceLedger(16 * MiB), input = fixture();
    input.plan = { ...input.plan, headerSha256: '0'.repeat(64) };
    const owner = builder(ledger, input);
    await expect(owner.append(owner.nextRange, input.bytes.buffer)).rejects.toThrow(/header integrity/);
    expect(ledger.usage.bytes).toBe(0);
  });
  it('checks the native flat payload SHA before producing prepared ownership, despite valid per-chunk hashes', async () => {
    const ledger = new ResourceLedger(16 * MiB), old = await snapshot(ledger), before = ledger.usage.bytes;
    const input = fixture(MiB + 81), owner = builder(ledger, input);
    input.bytes[MiB + 1] ^= 1;
    await fill(owner, input.bytes);
    await expect(owner.prepare()).rejects.toThrow(/native payload integrity/);
    expect(ledger.usage.bytes).toBe(before);
    expect(await readAll(old, ledger)).toEqual(fixture().bytes);
    old.release(); expect(ledger.usage.bytes).toBe(0);
  });
  it('refuses truncation before prepare and refuses extra bytes/chunks after the complete payload', async () => {
    const ledger = new ResourceLedger(16 * MiB), owner = builder(ledger);
    await expect(owner.prepare()).rejects.toThrow(/incomplete/);
    await fill(owner, fixture().bytes);
    await expect(owner.append({ index: 1, offset: MiB, length: 1 }, new ArrayBuffer(1))).rejects.toThrow(/range/);
    const prepared = await owner.prepare(); prepared.abort(); expect(ledger.usage.bytes).toBe(0);
  });
});

describe('joined cancellation, admitted restore copies and overlapping generations', () => {
  it('does not reuse incoming/hash admission while a real deferred Web Crypto digest is still running', async () => {
    const ledger = new ResourceLedger(16 * MiB), owner = builder(ledger), before = ledger.usage.bytes, hold = holdNextDigest();
    const received = owner.append(owner.nextRange, fixture().bytes.buffer).catch(error => error);
    await hold.started;
    let joined = false; const cancelled = owner.cancel().then(() => { joined = true; });
    await Promise.resolve(); expect(joined).toBe(false); expect(ledger.usage.bytes).toBe(before);
    hold.release(); expect(await received).toBeInstanceOf(Error); await cancelled;
    expect(ledger.usage.bytes).toBe(0); await owner.cancel(); expect(ledger.usage.bytes).toBe(0);
  });
  it('joins cancellation during canonical metadata hashing before releasing completed candidate chunks', async () => {
    const ledger = new ResourceLedger(16 * MiB), owner = builder(ledger);
    await fill(owner, fixture().bytes);
    const before = ledger.usage.bytes, hold = holdNextDigest(), prepared = owner.prepare().catch(error => error);
    await hold.started;
    let joined = false; const cancelled = owner.cancel().then(() => { joined = true; });
    await Promise.resolve(); expect(joined).toBe(false); expect(ledger.usage.bytes).toBe(before);
    hold.release(); expect(await prepared).toBeInstanceOf(Error); await cancelled;
    expect(ledger.usage.bytes).toBe(0);
  });
  it('retains old/new owners and the active restore copy simultaneously until its receiver explicitly joins', async () => {
    const ledger = new ResourceLedger(32 * MiB), old = await snapshot(ledger), oldBytes = ledger.usage.bytes;
    const reader = await old.openRestore(binding(), ledger), withReader = ledger.usage.bytes;
    expect(withReader).toBeGreaterThan(oldBytes);
    const copy = await reader.read(reader.nextRange);
    const candidate = builder(ledger); expect(ledger.usage.bytes).toBeGreaterThan(withReader + oldBytes);
    await fill(candidate, fixture().bytes); const replacement = (await candidate.prepare()).accept();
    expect(ledger.usage.bytes).toBe(withReader + oldBytes);
    old.release(); old.release(); expect(ledger.usage.bytes).toBe(withReader + oldBytes);
    let joined = false; const cancellation = reader.cancel().then(() => { joined = true; });
    await Promise.resolve(); expect(joined).toBe(false); expect(ledger.usage.bytes).toBe(withReader + oldBytes);
    copy.release(); await cancellation;
    expect(ledger.usage.bytes).toBe(oldBytes);
    expect(await readAll(replacement, ledger)).toEqual(fixture().bytes);
    replacement.release(); expect(ledger.usage.bytes).toBe(0);
  });
  it('a refused candidate reservation leaves previous accepted ownership readable and unchanged', async () => {
    const ledger = new ResourceLedger(16 * MiB), old = await snapshot(ledger), oldBytes = ledger.usage.bytes;
    const probe = new ResourceLedger(16 * MiB), probeOwner = builder(probe), candidateBytes = probe.usage.bytes;
    await probeOwner.cancel();
    const filler = ledger.reserve('render', ledger.limit - oldBytes - candidateBytes + 1), before = ledger.usage;
    expect(() => builder(ledger)).toThrow(/budget/);
    expect(ledger.usage.bytes).toBe(before.bytes); expect(ledger.usage.allocations).toBe(before.allocations);
    filler(); expect(await readAll(old, ledger)).toEqual(fixture().bytes);
    old.release(); expect(ledger.usage.bytes).toBe(0);
  });
  it('refuses cross-ledger borrowing, duplicate restore readers, bad read ranges, and finish before the final joined copy', async () => {
    const ledger = new ResourceLedger(16 * MiB), other = new ResourceLedger(16 * MiB), accepted = await snapshot(ledger);
    const retained = ledger.usage.bytes;
    await expect(accepted.openRestore(binding(), other)).rejects.toThrow(/another ledger/);
    expect(other.usage.bytes).toBe(0); expect(ledger.usage.bytes).toBe(retained);
    const reader = await accepted.openRestore(binding(), ledger);
    await expect(accepted.openRestore(binding(), ledger)).rejects.toThrow(/outstanding/);
    await expect(reader.read({ index: 0, offset: 1, length: 128 })).rejects.toThrow(/range/);
    await expect(reader.finish()).rejects.toThrow(/incomplete/);
    const copy = await reader.read(reader.nextRange);
    await expect(reader.read({ index: 1, offset: MiB, length: 1 })).rejects.toThrow(/outstanding/);
    await expect(reader.finish()).rejects.toThrow(/incomplete/);
    copy.release(); await reader.finish(); await reader.cancel();
    expect(ledger.usage.bytes).toBe(retained); accepted.release();
    await expect(accepted.openRestore(binding(), ledger)).rejects.toThrow(/released/);
    expect(ledger.usage.bytes).toBe(0);
  });
  it('lets a fresh copy be genuinely transferred and releases only after the receiver acknowledgement', async () => {
    const ledger = new ResourceLedger(16 * MiB), accepted = await snapshot(ledger), reader = await accepted.openRestore(binding(), ledger);
    const copy = await reader.read(reader.nextRange), received = structuredClone(copy.bytes, { transfer: [copy.bytes] });
    expect(copy.bytes.byteLength).toBe(0); expect(new Uint8Array(received)).toEqual(fixture().bytes);
    accepted.release(); let joined = false; const cancelled = reader.cancel().then(() => { joined = true; });
    await Promise.resolve(); expect(joined).toBe(false); expect(ledger.usage.bytes).toBeGreaterThan(0);
    copy.release(); await cancelled; expect(ledger.usage.bytes).toBe(0);
  });
  it('retains read/hash credit through cancellation until the actual deferred digest settles', async () => {
    const ledger = new ResourceLedger(16 * MiB), accepted = await snapshot(ledger), reader = await accepted.openRestore(binding(), ledger);
    const before = ledger.usage.bytes, hold = holdNextDigest(), pending = reader.read(reader.nextRange).catch(error => error);
    await hold.started; accepted.release();
    let joined = false; const cancelled = reader.cancel().then(() => { joined = true; });
    await Promise.resolve(); expect(joined).toBe(false); expect(ledger.usage.bytes).toBe(before);
    hold.release(); expect(await pending).toBeInstanceOf(Error); await cancelled;
    expect(ledger.usage.bytes).toBe(0);
  });
  it('can abort initial full integrity verification and joins its digest before releasing an already-released owner', async () => {
    const ledger = new ResourceLedger(16 * MiB), accepted = await snapshot(ledger), abort = new AbortController(), hold = holdNextDigest();
    const opening = accepted.openRestore(binding(), ledger, abort.signal).catch(error => error);
    await hold.started; const before = ledger.usage.bytes; accepted.release(); abort.abort();
    await Promise.resolve(); expect(ledger.usage.bytes).toBe(before);
    hold.release(); expect(await opening).toBeInstanceOf(Error);
    expect(ledger.usage.bytes).toBe(0);
  });
  it('refuses an already-aborted or forged abort signal before admitting restore work', async () => {
    const ledger = new ResourceLedger(16 * MiB), accepted = await snapshot(ledger), before = ledger.usage.bytes;
    const abort = new AbortController(); abort.abort();
    await expect(accepted.openRestore(binding(), ledger, abort.signal)).rejects.toThrow(/cancelled/);
    await expect(accepted.openRestore(binding(), ledger, { aborted: false } as AbortSignal)).rejects.toThrow(/abort signal/);
    expect(ledger.usage.bytes).toBe(before); accepted.release(); expect(ledger.usage.bytes).toBe(0);
  });
  it('rejects a failed cryptographic metadata or chunk verification before producing import copies', async () => {
    const ledger = new ResourceLedger(16 * MiB), accepted = await snapshot(ledger), before = ledger.usage.bytes;
    vi.spyOn(crypto.subtle, 'digest').mockResolvedValueOnce(new Uint8Array(32).buffer);
    await expect(accepted.openRestore(binding(), ledger)).rejects.toThrow(/metadata integrity/);
    expect(ledger.usage.bytes).toBe(before);
    vi.restoreAllMocks();
    const realDigest = crypto.subtle.digest.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce((algorithm, bytes) => realDigest(algorithm, bytes))
      .mockResolvedValueOnce(new Uint8Array(32).buffer);
    await expect(accepted.openRestore(binding(), ledger)).rejects.toThrow(/chunk integrity/);
    expect(ledger.usage.bytes).toBe(before);
    vi.restoreAllMocks(); expect(await readAll(accepted, ledger)).toEqual(fixture().bytes);
    accepted.release(); expect(ledger.usage.bytes).toBe(0);
  });
  it('refuses malformed cryptographic digest buffers and preserves old accepted ownership', async () => {
    const ledger = new ResourceLedger(16 * MiB), old = await snapshot(ledger), before = ledger.usage.bytes, owner = builder(ledger);
    vi.spyOn(crypto.subtle, 'digest').mockResolvedValueOnce(new ArrayBuffer(31));
    await expect(owner.append(owner.nextRange, fixture().bytes.buffer)).rejects.toThrow(/ArrayBuffer/);
    expect(ledger.usage.bytes).toBe(before); old.release(); expect(ledger.usage.bytes).toBe(0);
  });
});
