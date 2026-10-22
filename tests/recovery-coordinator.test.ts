import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DocumentRecoveryStore, assertExternalCommitDecision, recoveryPublicationRevision,
  type ExternalCommitDecision } from '../src/document/recoveryCoordinator';
import { RecoveryCheckpointBuilder, PreparedRecoveryCheckpoint,
  type RecoveryCheckpointBinding, type RecoveryCheckpointDescription, type RecoveryCheckpointPlan } from '../src/document/recoveryCheckpoint';
import { MiB, ResourceLedger } from '../src/document/resources';
import type { OperationOwner } from '../src/document/operationProtocol';
import type { Revision } from '../src/document/types';

const DOCUMENT = '10000000-0000-4000-8000-000000000001';
const CLIENT = '20000000-0000-4000-8000-000000000001';
const CLIENT_2 = '20000000-0000-4000-8000-000000000002';
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function binding(revision: Partial<Revision> = {}) {
  return { version: 1 as const,
    core: { schemaVersion: 1 as const, kind: 'core' as const, abi: 18, variant: 'scalar' as const,
      nativeInputId: 'a'.repeat(64), mapLayoutVersion: 1, capabilities: { document: 1, recoveryCheckpoint: 2 } },
    source: { scheme: 'splatview-source-v1' as const, assetDigest: 'b'.repeat(64), resourceCount: 1,
      totalBytes: 1024, sourceKindHint: 'PLY' },
    subset: { sourceCount: 12, loadedCount: 6, maxSplats: 6 },
    revision: { documentId: DOCUMENT, sourceGeneration: 2, contentRevision: 4, selectionRevision: 7, draftRevision: 0,
      ...revision } };
}
function owner(operationId = 1, clientGeneration = CLIENT): OperationOwner {
  return { version: 1, documentId: DOCUMENT, sourceGeneration: 2, clientGeneration, operationId };
}
/** This framing fixture exercises the genuine external integrity/admission
 * owner. It does not manufacture a native operation outcome or restoration.
 */
async function prepare(ledger: ResourceLedger, generation = 0, bound: RecoveryCheckpointBinding = binding(), byteLength = 128) {
  const bytes = new Uint8Array(byteLength);
  for (let index = 64; index < bytes.length; index++) bytes[index] = (index * 19 + generation) & 255;
  const sha256 = digest(bytes.subarray(64));
  bytes.set(new TextEncoder().encode('SVCKPT01'));
  const header = new DataView(bytes.buffer);
  header.setUint32(8, 3, true); header.setUint32(12, 64, true); header.setBigUint64(16, BigInt(byteLength), true);
  bytes.set(Uint8Array.from(sha256.match(/../g)!, pair => Number.parseInt(pair, 16)), 24);
  const plan: RecoveryCheckpointPlan = { ok: true, version: 2, byteLength, workspaceBytes: 8192, maximumChunkBytes: 1048576,
    sceneCount: 3, maskCount: 4, normalizationFlags: 0, actualRevision: 7, revision: 7,
    currentLoadedCount: 6, currentSourceCount: bound.subset.sourceCount, currentDuplicateRange: null, maximumGraphSplats: 6,
    contentRevision: 4, nextContentRevision: 9, memoryBytes: 32768, sha256,
    headerSha256: digest(bytes.subarray(0, 64)) };
  const builder = new RecoveryCheckpointBuilder(ledger, bound, bound, plan,
    { alignedCamera: [generation, 0, 1], outputReceipts: [] });
  try {
    while (builder.nextRange) {
      const range = builder.nextRange!;
      await builder.append(range, bytes.slice(range.offset, range.offset + range.length).buffer);
    }
    return await builder.prepare();
  } catch (error) { await builder.cancel(); throw error; }
}
async function installed(ledger = new ResourceLedger(16 * MiB)) {
  const store = new DocumentRecoveryStore(ledger), prepared = await prepare(ledger);
  store.installInitial(prepared);
  return { store, ledger, initial: prepared.description };
}
async function readAll(store: DocumentRecoveryStore) {
  const reader = await store.openRestore(), bytes = new Uint8Array(reader.description.plan.byteLength);
  while (reader.nextRange) {
    const chunk = await reader.read(reader.nextRange);
    bytes.set(new Uint8Array(chunk.bytes), chunk.offset); chunk.release();
  }
  await reader.finish();
  return bytes;
}

describe('document recovery decision ownership', () => {
  it('installs exactly one initial admitted checkpoint without exposing its release handle', async () => {
    const { store, ledger, initial } = await installed();
    expect(store.description).toBe(initial); expect(Object.isFrozen(store)).toBe(true);
    expect(Reflect.ownKeys(store)).toEqual([]);
    const duplicate = await prepare(ledger, 1), before = ledger.usage.bytes;
    expect(() => store.installInitial(duplicate)).toThrow(/already owned/);
    expect(ledger.usage.bytes).toBe(before);
    duplicate.abort();
    expect((await readAll(store))[64]).toBe((64 * 19) & 255);
    store.release(); expect(ledger.usage.bytes).toBe(0);
  });
  it('requires an initial checkpoint before a decision or restore and leaves rejected candidates owned', async () => {
    const ledger = new ResourceLedger(16 * MiB), store = new DocumentRecoveryStore(ledger), prepared = await prepare(ledger);
    expect(store.description).toBeUndefined();
    expect(() => store.decide(owner(), prepared)).toThrow(/missing initial/);
    await expect(store.openRestore()).rejects.toThrow(/missing initial/);
    store.installInitial(prepared); store.release(); expect(ledger.usage.bytes).toBe(0);
  });
  it('makes acceptance irreversible and binds a genuine opaque token to its exact operation and root', async () => {
    const { store, ledger, initial } = await installed(), prepared = await prepare(ledger, 1,
      binding({ contentRevision: 5, selectionRevision: 8 }));
    const decision = store.decide(owner(), prepared), accepted = prepared.description;
    expect(Object.isFrozen(decision)).toBe(true); expect(Reflect.ownKeys(decision)).toEqual([]);
    expect(assertExternalCommitDecision(decision, owner())).toBe(accepted);
    expect(assertExternalCommitDecision(decision, owner(), structuredClone(accepted))).toBe(accepted);
    expect(accepted.rootSha256).not.toBe(initial.rootSha256);
    prepared.abort();
    expect(store.description).toBe(accepted);
    expect(assertExternalCommitDecision(decision, owner(), accepted)).toBe(accepted);
    expect(() => prepared.accept()).toThrow(/retired prepared/);
    expect((await readAll(store))[64]).toBe((64 * 19 + 1) & 255);
    store.release(); expect(ledger.usage.bytes).toBe(0);
  });
  it('refuses fabricated, cloned, inherited and proxy decision tokens without invoking their hooks', async () => {
    const { store, ledger } = await installed(), decision = store.decide(owner(), await prepare(ledger, 1));
    let hooks = 0;
    const fake = new Proxy({}, { get() { hooks++; throw new Error('getter must not execute'); } });
    for (const token of [{}, structuredClone(decision), Object.create(decision), fake, null, undefined, 1])
      expect(() => assertExternalCommitDecision(token as ExternalCommitDecision, owner())).toThrow(/unrecognized token/);
    expect(hooks).toBe(0); store.release(); expect(ledger.usage.bytes).toBe(0);
  });
  it.each([
    ['operation', { operationId: 2 }], ['client', { clientGeneration: CLIENT_2 }],
    ['document', { documentId: '10000000-0000-4000-8000-000000000002' }], ['source generation', { sourceGeneration: 3 }],
  ])('refuses a decision for another %s', async (_label, changed) => {
    const { store, ledger } = await installed(), decision = store.decide(owner(), await prepare(ledger, 1));
    expect(() => assertExternalCommitDecision(decision, { ...owner(), ...changed })).toThrow(/operation owner/);
    store.release(); expect(ledger.usage.bytes).toBe(0);
  });
  it.each([
    ['root', (value: RecoveryCheckpointDescription) => ({ ...value, rootSha256: '0'.repeat(64) })],
    ['metadata', (value: RecoveryCheckpointDescription) => ({ ...value, metadata: { alignedCamera: [99, 0, 1], outputReceipts: [] } })],
    ['revision', (value: RecoveryCheckpointDescription) => ({ ...value,
      binding: { ...value.binding, revision: { ...value.binding.revision, selectionRevision: 100 } } })],
    ['chunk hash', (value: RecoveryCheckpointDescription) => ({ ...value, chunks: [{ ...value.chunks[0], sha256: '0'.repeat(64) }] })],
  ])('checks the complete optional description including %s', async (_label, changed) => {
    const { store, ledger } = await installed(), decision = store.decide(owner(), await prepare(ledger, 1));
    expect(() => assertExternalCommitDecision(decision, owner(), changed(store.description!))).toThrow(/description or root/);
    store.release(); expect(ledger.usage.bytes).toBe(0);
  });
  it('does not evaluate description, operation-owner, or revision accessors', async () => {
    const { store, ledger } = await installed(), decision = store.decide(owner(), await prepare(ledger, 1));
    let hooks = 0;
    const description = { ...store.description! };
    Object.defineProperty(description, 'rootSha256', { enumerable: true, get() { hooks++; throw new Error('untrusted root'); } });
    expect(() => assertExternalCommitDecision(decision, owner(), description)).toThrow(/description or root/);
    const badOwner = { ...owner() };
    Object.defineProperty(badOwner, 'operationId', { enumerable: true, get() { hooks++; throw new Error('untrusted owner'); } });
    expect(() => assertExternalCommitDecision(decision, badOwner)).toThrow(/Invalid operation receipt/);
    const badRevision = { ...binding().revision };
    Object.defineProperty(badRevision, 'contentRevision', { enumerable: true, get() { hooks++; throw new Error('untrusted revision'); } });
    expect(() => recoveryPublicationRevision(badRevision, binding().revision)).toThrow(/revision fields/);
    expect(hooks).toBe(0); store.release(); expect(ledger.usage.bytes).toBe(0);
  });
  it('authenticates prepared private ownership without invoking caller overrides', async () => {
    const { store, ledger } = await installed();
    let hooks = 0;
    const fake = { get description() { hooks++; throw new Error('untrusted description'); },
      accept() { hooks++; throw new Error('untrusted accept'); } };
    expect(() => store.decide(owner(), fake as unknown as PreparedRecoveryCheckpoint)).toThrow();
    const target = await prepare(ledger, 1);
    expect(() => store.decide(owner(), new Proxy(target, {}))).toThrow();
    // The proxy cannot authenticate private fields; retire its genuine target.
    target.abort();
    expect(hooks).toBe(0); store.release(); expect(ledger.usage.bytes).toBe(0);
  });
  it('rejects an aborted candidate without changing the previously accepted root', async () => {
    const { store, ledger, initial } = await installed(), candidate = await prepare(ledger, 1);
    candidate.abort();
    expect(() => store.decide(owner(), candidate)).toThrow(/retired prepared/);
    expect(store.description).toBe(initial);
    expect((await readAll(store))[64]).toBe((64 * 19) & 255);
    store.release(); expect(ledger.usage.bytes).toBe(0);
  });
  it('rejects repeated and decreasing IDs within one client while allowing a verified fresh generation', async () => {
    const { store, ledger } = await installed(), first = store.decide(owner(3), await prepare(ledger, 1));
    for (const operationId of [3, 2, 1]) {
      const candidate = await prepare(ledger, 2);
      expect(() => store.decide(owner(operationId), candidate)).toThrow(/did not advance/);
      candidate.abort(); expect(assertExternalCommitDecision(first, owner(3))).toBe(store.description);
    }
    const second = store.decide(owner(4), await prepare(ledger, 2));
    expect(() => assertExternalCommitDecision(first, owner(3))).toThrow(/no longer owned/);
    expect(assertExternalCommitDecision(second, owner(4))).toBe(store.description);
    const fresh = store.decide(owner(1, CLIENT_2), await prepare(ledger, 3));
    expect(assertExternalCommitDecision(fresh, owner(1, CLIENT_2))).toBe(store.description);
    expect(() => assertExternalCommitDecision(second, owner(4))).toThrow(/no longer owned/);
    store.release(); expect(ledger.usage.bytes).toBe(0);
  });
  it.each([
    ['native core', (value: ReturnType<typeof binding>) => { value.core.nativeInputId = 'c'.repeat(64); }],
    ['native ABI', (value: ReturnType<typeof binding>) => { value.core.abi++; }],
    ['native capabilities', (value: ReturnType<typeof binding>) => { value.core.capabilities.document++; }],
    ['source digest', (value: ReturnType<typeof binding>) => { value.source.assetDigest = 'c'.repeat(64); }],
    ['source format', (value: ReturnType<typeof binding>) => { value.source.sourceKindHint = 'SPZ'; }],
    ['source resource count', (value: ReturnType<typeof binding>) => { value.source.resourceCount++; }],
    ['source size', (value: ReturnType<typeof binding>) => { value.source.totalBytes++; }],
    ['loaded subset', (value: ReturnType<typeof binding>) => { value.subset.loadedCount--; }],
    ['subset cap', (value: ReturnType<typeof binding>) => { value.subset.maxSplats++; }],
    ['source count', (value: ReturnType<typeof binding>) => { value.subset.sourceCount++; }],
    ['document', (value: ReturnType<typeof binding>) => { value.revision.documentId = '10000000-0000-4000-8000-000000000002'; }],
    ['source generation', (value: ReturnType<typeof binding>) => { value.revision.sourceGeneration++; }],
  ])('refuses a successor with another %s before transferring ownership', async (_label, changed) => {
    const { store, ledger, initial } = await installed(), incompatible = binding(); changed(incompatible);
    const candidate = await prepare(ledger, 1, incompatible), before = ledger.usage.bytes;
    expect(() => store.decide(owner(), candidate)).toThrow(/binding/);
    expect(store.description).toBe(initial); expect(ledger.usage.bytes).toBe(before);
    candidate.abort(); store.release(); expect(ledger.usage.bytes).toBe(0);
  });
  it('requires matching owner document/source even when the successor binding itself is compatible', async () => {
    const { store, ledger, initial } = await installed(), candidate = await prepare(ledger, 1);
    expect(() => store.decide({ ...owner(), sourceGeneration: 3 }, candidate)).toThrow(/binding/);
    expect(store.description).toBe(initial);
    const decision = store.decide(owner(), candidate);
    expect(assertExternalCommitDecision(decision, owner())).toBe(store.description);
    store.release(); expect(ledger.usage.bytes).toBe(0);
  });
  it('refuses another ledger for both initial and successor acceptance without consuming their candidates', async () => {
    const ledger = new ResourceLedger(16 * MiB), foreign = new ResourceLedger(16 * MiB), store = new DocumentRecoveryStore(ledger);
    const candidate = await prepare(foreign), foreignBytes = foreign.usage.bytes;
    expect(() => store.installInitial(candidate)).toThrow(/another ledger/);
    expect(store.description).toBeUndefined(); expect(foreign.usage.bytes).toBe(foreignBytes);
    store.installInitial(await prepare(ledger));
    expect(() => store.decide(owner(), candidate)).toThrow(/another ledger/);
    const snapshot = candidate.accept(foreign); expect(snapshot.description).toBe(candidate.description);
    snapshot.release(); store.release(); expect(ledger.usage.bytes).toBe(0); expect(foreign.usage.bytes).toBe(0);
  });
  it('keeps the old snapshot when the successor cannot be admitted alongside it', async () => {
    const { store, ledger, initial } = await installed(new ResourceLedger(4 * MiB)), retained = ledger.usage.bytes;
    const blocker = ledger.reserve('work', ledger.limit - retained - 128 * 1024);
    await expect(prepare(ledger, 1, binding(), MiB)).rejects.toThrow(/budget/);
    expect(store.description).toBe(initial); expect(ledger.usage.bytes).toBe(retained + blocker.bytes);
    blocker(); expect((await readAll(store))[64]).toBe((64 * 19) & 255);
    store.release(); expect(ledger.usage.bytes).toBe(0);
  });
  it('charges both generations through a held predecessor reader and returns its credit only after the copy joins', async () => {
    const { store, ledger, initial } = await installed(), oldBytes = ledger.usage.bytes;
    const reader = await store.openRestore(), chunk = await reader.read(reader.nextRange);
    expect(reader.description).toBe(initial);
    const readBytes = ledger.usage.bytes - oldBytes;
    const candidate = await prepare(ledger, 1), coexist = ledger.usage.bytes;
    const candidateBytes = coexist - oldBytes - readBytes;
    const decision = store.decide(owner(), candidate);
    expect(ledger.usage.bytes).toBe(coexist);
    const closing = reader.cancel();
    await Promise.resolve(); expect(ledger.usage.bytes).toBe(coexist);
    expect(new Uint8Array(chunk.bytes)[64]).toBe((64 * 19) & 255);
    chunk.release(); await closing;
    expect(() => new Uint8Array(chunk.bytes)).toThrow();
    expect(ledger.usage.bytes).toBe(candidateBytes);
    expect(assertExternalCommitDecision(decision, owner())).toBe(store.description);
    store.release(); expect(ledger.usage.bytes).toBe(0);
  });
  it('invalidates proofs immediately on release while reader/copy credits remain until their actual join', async () => {
    const { store, ledger } = await installed(), decision = store.decide(owner(), await prepare(ledger, 1));
    const reader = await store.openRestore(), chunk = await reader.read(reader.nextRange), before = ledger.usage.bytes;
    store.release(); store.release();
    expect(store.description).toBeUndefined(); expect(ledger.usage.bytes).toBe(before);
    expect(() => assertExternalCommitDecision(decision, owner())).toThrow(/no longer owned/);
    await expect(store.openRestore()).rejects.toThrow(/released store/);
    const closing = reader.cancel(); await Promise.resolve(); expect(ledger.usage.bytes).toBe(before);
    chunk.release(); await closing; expect(ledger.usage.bytes).toBe(0);
    const candidate = await prepare(ledger, 2);
    expect(() => store.installInitial(candidate)).toThrow(/released store/);
    expect(() => store.decide(owner(2), candidate)).toThrow(/released store/);
    candidate.abort(); expect(ledger.usage.bytes).toBe(0);
  });
  it('joins a cancelled reader without altering the accepted external decision', async () => {
    const { store, ledger } = await installed(), decision = store.decide(owner(), await prepare(ledger, 1));
    const retained = ledger.usage.bytes, abort = new AbortController(), reader = await store.openRestore(abort.signal);
    abort.abort(); await reader.cancel();
    expect(ledger.usage.bytes).toBe(retained); expect(reader.description).toBe(store.description);
    expect(assertExternalCommitDecision(decision, owner())).toBe(store.description);
    await expect(store.openRestore(abort.signal)).rejects.toThrow(/cancelled/);
    expect((await readAll(store))[64]).toBe((64 * 19 + 1) & 255);
    store.release(); expect(ledger.usage.bytes).toBe(0);
  });
});

describe('explicit restored publication revision', () => {
  it('preserves every public counter for the same quiescent checkpoint and source', () => {
    const original = binding().revision, result = recoveryPublicationRevision(original, { ...original });
    expect(result).toEqual(original); expect(result).not.toBe(original); expect(Object.isFrozen(result)).toBe(true);
  });
  it.each([[4, 5, 6], [5, 4, 6], [0, 99, 100]])('publishes differing content %i/%i above both as %i', (saved, failed, expected) => {
    const result = recoveryPublicationRevision(binding({ contentRevision: saved }).revision, binding({ contentRevision: failed }).revision);
    expect(result.contentRevision).toBe(expected); expect(result.selectionRevision).toBe(7); expect(result.draftRevision).toBe(0);
  });
  it.each([[7, 8, 9], [8, 7, 9], [0, 99, 100]])('publishes differing selection %i/%i above both as %i', (saved, failed, expected) => {
    const result = recoveryPublicationRevision(binding({ selectionRevision: saved }).revision, binding({ selectionRevision: failed }).revision);
    expect(result.selectionRevision).toBe(expected); expect(result.contentRevision).toBe(4); expect(result.draftRevision).toBe(0);
  });
  it.each([[0, 1], [1, 0], [2, 3]])('cancels unfinished draft ownership %i/%i with an explicit selection transition', (saved, failed) => {
    expect(recoveryPublicationRevision(binding({ draftRevision: saved }).revision, binding({ draftRevision: failed }).revision))
      .toEqual({ ...binding().revision, selectionRevision: 8, draftRevision: 0 });
  });
  it.each([{ sourceGeneration: 3 }, { documentId: 'another-document' }])('rejects a different source/document lineage %o', changed => {
    expect(() => recoveryPublicationRevision(binding().revision, binding(changed).revision)).toThrow(/document or source generation/);
  });
  it.each([-1, -0, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])('rejects invalid counters %s before publication', invalid => {
    for (const field of ['sourceGeneration', 'contentRevision', 'selectionRevision', 'draftRevision'])
      expect(() => recoveryPublicationRevision(binding().revision, { ...binding().revision, [field]: invalid })).toThrow(/revision integer/);
  });
  it('refuses an overflowing explicit transition while preserving a valid maximal quiescent counter', () => {
    const maximal = binding({ contentRevision: Number.MAX_SAFE_INTEGER, selectionRevision: Number.MAX_SAFE_INTEGER }).revision;
    expect(recoveryPublicationRevision(maximal, maximal)).toEqual(maximal);
    expect(() => recoveryPublicationRevision(maximal, binding().revision)).toThrow(/overflow/);
    expect(() => recoveryPublicationRevision(maximal, { ...maximal, draftRevision: 1 })).toThrow(/overflow/);
  });
});
