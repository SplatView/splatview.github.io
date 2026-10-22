import type { NativeIdentity } from '../build/contracts';
import { canonicalJson, parseNativeIdentity } from '../build/verification';
import { SOURCE_FINGERPRINT_SCHEME, type SourceFingerprint } from '../io/fingerprint';
import { AdmissionError, MiB, ResourceLedger, assertResourceCredit, checkedBytes,
  estimateRecoveryCheckpointBytes, resourceLeaseCredit, type ResourceLease } from './resources';
import type { Revision } from './types';
import { IncrementalCheckpointHash } from './checkpointHash';
import { validateDuplicateRange, type DuplicateRange } from './duplicateProtocol';

/** The codec is native v3; this owner neither interprets its graph nor declares
 * a native commit. A coordinator must bind the matching browser metadata and
 * accept a prepared snapshot before claiming that a commit is recoverable.
 */
export type RecoveryCheckpointBinding = Readonly<{
  version: 1;
  core: Readonly<NativeIdentity>;
  source: Readonly<SourceFingerprint>;
  subset: Readonly<{ sourceCount: number; loadedCount: number; maxSplats: number }>;
  revision: Readonly<Revision>;
}>;
export type RecoveryCheckpointPlan = Readonly<{
  ok: true; version: 2; byteLength: number; workspaceBytes: number; maximumChunkBytes: 1048576;
  sceneCount: number; maskCount: number; normalizationFlags: number;
  currentLoadedCount: number; currentSourceCount: number; currentDuplicateRange: DuplicateRange; maximumGraphSplats: number;
  revision: number; actualRevision: number; contentRevision: number; nextContentRevision: number; memoryBytes: number;
  /** Native codec payload hash, distinct from the external complete-binary hash tree. */
  sha256: string; headerSha256: string;
}>;
export type RecoveryJson = null | boolean | number | string | readonly RecoveryJson[] |
  { readonly [key: string]: RecoveryJson };
export type RecoveryCheckpointRange = Readonly<{ index: number; offset: number; length: number }>;
export type RecoveryCheckpointChunk = RecoveryCheckpointRange & Readonly<{ sha256: string }>;
export type RecoveryCheckpointDescription = Readonly<{
  version: 1; binding: RecoveryCheckpointBinding; plan: RecoveryCheckpointPlan; metadata: RecoveryJson;
  metadataSha256: string; rootSha256: string; chunks: readonly RecoveryCheckpointChunk[];
}>;

const HASH = /^[0-9a-f]{64}$/;
const MAX_METADATA_BYTES = 256 * 1024;
const MAX_METADATA_NODES = 65536;
const ROOT_DOMAIN = 'splatview-external-checkpoint-v1';
const OWNER = Symbol('recovery-checkpoint-owner');
const bufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;
const bufferResizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get;
const signalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const cancelled = () => new Error('The recovery checkpoint operation was cancelled.');
const invalid = (detail: string) => new Error(`Invalid recovery checkpoint ${detail}.`);

function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || Object.is(value, -0) || value < min || value > max)
    throw invalid('integer');
  return value;
}
function record(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype)
    throw invalid('object');
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some(key => typeof key !== 'string' || !fields.includes(key))) throw invalid('fields');
  return Object.fromEntries(fields.map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) throw invalid('fields');
    return [key, descriptor.value];
  }));
}
function text(value: unknown, limit: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > limit) throw invalid('text');
  return value;
}
function hashText(value: unknown): string {
  if (typeof value !== 'string' || !HASH.test(value)) throw invalid('SHA-256');
  return value;
}

/** Refuse accessors, hidden/symbol fields, prototypes, cycles, holes and values
 * JSON would silently discard/coerce. Both caller and worker descriptors pass
 * through the same bounded independent snapshot before exact comparison.
 */
function jsonSnapshot(value: unknown): { value: RecoveryJson; nodes: number; units: number } {
  let nodes = 0, units = 0;
  const path = new Set<object>();
  const consume = (length: number) => {
    units = checkedBytes(units + length, 1);
    if (units > MAX_METADATA_BYTES) throw invalid('metadata bound');
  };
  function visit(input: unknown, depth: number): RecoveryJson {
    if (++nodes > MAX_METADATA_NODES || depth > 32) throw invalid('metadata depth or node bound');
    if (input === null || typeof input === 'boolean') { consume(5); return input; }
    if (typeof input === 'number') {
      if (!Number.isFinite(input) || Object.is(input, -0)) throw invalid('metadata number');
      consume(32); return input;
    }
    if (typeof input === 'string') { consume(input.length * 6 + 2); return input; }
    if (!input || typeof input !== 'object' || path.has(input)) throw invalid('JSON metadata');
    path.add(input);
    try {
      if (Array.isArray(input)) {
        // Preflight length before enumerating a huge dense/sparse input. Never
        // build a descriptor object for every property before enforcing bounds.
        const length = integer(Object.getOwnPropertyDescriptor(input, 'length')?.value, 0, MAX_METADATA_NODES - nodes);
        const keys = Reflect.ownKeys(input);
        if (keys.length !== length + 1) throw invalid('metadata array');
        const values: RecoveryJson[] = [];
        for (let index = 0; index < length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
          if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw invalid('metadata array');
          values.push(visit(descriptor.value, depth + 1));
        }
        consume(length + 2); return Object.freeze(values);
      }
      if (Object.getPrototypeOf(input) !== Object.prototype) throw invalid('metadata prototype');
      const keys = Reflect.ownKeys(input);
      if (keys.length > MAX_METADATA_NODES - nodes) throw invalid('metadata node bound');
      const entries: [string, RecoveryJson][] = [];
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        if (typeof key !== 'string' || key.length > 4096 || !descriptor?.enumerable || !('value' in descriptor))
          throw invalid('metadata property');
        consume(key.length * 6 + 4);
        entries.push([key, visit(descriptor.value, depth + 1)]);
      }
      consume(2); return Object.freeze(Object.fromEntries(entries));
    } finally { path.delete(input); }
  }
  return { value: visit(value, 0), nodes, units };
}

export function validateRecoveryCheckpointBinding(value: unknown): RecoveryCheckpointBinding {
  // This also isolates nested capability/source values before existing parsers run.
  const snapshot = jsonSnapshot(value).value;
  const data = record(snapshot, ['version', 'core', 'source', 'subset', 'revision']);
  if (data.version !== 1) throw invalid('binding version');
  const core = parseNativeIdentity(data.core);
  if (core.kind !== 'core' || core.capabilities.recoveryCheckpoint !== 2) throw invalid('core identity or checkpoint capability');
  const source = record(data.source, ['scheme', 'assetDigest', 'resourceCount', 'totalBytes', 'sourceKindHint']);
  if (source.scheme !== SOURCE_FINGERPRINT_SCHEME) throw invalid('source scheme');
  hashText(source.assetDigest); integer(source.resourceCount, 1, 0xffff_ffff); integer(source.totalBytes);
  text(source.sourceKindHint, 128);
  const subset = record(data.subset, ['sourceCount', 'loadedCount', 'maxSplats']);
  integer(subset.sourceCount, 1, 0xffff_ffff); integer(subset.loadedCount, 1, 1_000_000);
  integer(subset.maxSplats, 1, 1_000_000);
  if (Number(subset.loadedCount) > Number(subset.sourceCount) || Number(subset.loadedCount) > Number(subset.maxSplats))
    throw invalid('loaded subset');
  const revision = record(data.revision, ['documentId', 'sourceGeneration', 'contentRevision', 'selectionRevision', 'draftRevision']);
  text(revision.documentId, 128); integer(revision.sourceGeneration, 1);
  integer(revision.contentRevision); integer(revision.selectionRevision); integer(revision.draftRevision);
  return snapshot as unknown as RecoveryCheckpointBinding;
}

export function assertRecoveryCheckpointBinding(actual: unknown, expected: unknown): RecoveryCheckpointBinding {
  const trusted = validateRecoveryCheckpointBinding(expected), received = validateRecoveryCheckpointBinding(actual);
  if (canonicalJson(received) !== canonicalJson(trusted)) throw invalid('source, subset, generation or native core binding');
  return received;
}

export function validateRecoveryCheckpointPlan(value: unknown): RecoveryCheckpointPlan {
  const data = record(value, ['ok', 'version', 'byteLength', 'workspaceBytes', 'maximumChunkBytes', 'sceneCount',
    'maskCount', 'normalizationFlags', 'currentLoadedCount', 'currentSourceCount', 'currentDuplicateRange', 'maximumGraphSplats',
    'revision', 'actualRevision', 'contentRevision', 'nextContentRevision', 'sha256', 'headerSha256', 'memoryBytes']);
  if (data.ok !== true || data.version !== 2 || data.maximumChunkBytes !== MiB) throw invalid('native plan version');
  integer(data.byteLength, 64, 0x7fff_ffff); integer(data.workspaceBytes, 0, 0xffff_ffff);
  integer(data.sceneCount, 1, 0xffff_ffff); integer(data.maskCount, 0, 0xffff_ffff);
  const currentLoadedCount = integer(data.currentLoadedCount, 0, 1_000_000);
  integer(data.currentSourceCount, Math.max(1, currentLoadedCount), 0xffff_ffff);
  integer(data.maximumGraphSplats, Math.max(1, currentLoadedCount), 1_000_000);
  data.currentDuplicateRange = validateDuplicateRange(data.currentDuplicateRange, currentLoadedCount);
  integer(data.normalizationFlags, 0, 127); integer(data.revision); integer(data.actualRevision);
  integer(data.contentRevision); integer(data.nextContentRevision);
  integer(data.memoryBytes);
  if (Number(data.nextContentRevision) < Number(data.contentRevision)) throw invalid('native revision high water');
  hashText(data.sha256); hashText(data.headerSha256);
  return Object.freeze(data) as RecoveryCheckpointPlan;
}

function ownedBuffer(value: unknown, length: number): ArrayBuffer {
  try {
    if (bufferLength.call(value) !== length || bufferResizable?.call(value)) throw invalid('buffer size or resizing');
    // A detached zero-byte buffer and a genuine empty buffer must remain distinct.
    new Uint8Array(value as ArrayBuffer);
  } catch { throw invalid('fixed, attached ArrayBuffer'); }
  return value as ArrayBuffer;
}
async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const result = await crypto.subtle.digest('SHA-256', bytes);
  ownedBuffer(result, 32);
  return Array.from(new Uint8Array(result), byte => byte.toString(16).padStart(2, '0')).join('');
}
function assertHeader(bytes: Uint8Array<ArrayBuffer>, plan: RecoveryCheckpointPlan) {
  if (bytes.byteLength < 64 || String.fromCharCode(...bytes.subarray(0, 8)) !== 'SVCKPT01') throw invalid('native codec header');
  const header = new DataView(bytes.buffer, bytes.byteOffset, 64);
  const codecVersion = header.getUint32(8, true);
  const digest = Array.from(bytes.subarray(24, 56), byte => byte.toString(16).padStart(2, '0')).join('');
  if (codecVersion !== 3 || header.getUint32(12, true) !== 64 ||
      header.getBigUint64(16, true) !== BigInt(plan.byteLength) || digest !== plan.sha256 ||
      header.getUint32(56, true) !== 0 || header.getUint32(60, true) !== plan.normalizationFlags)
    throw invalid('native codec header binding');
}
const encode = (value: unknown) => new TextEncoder().encode(canonicalJson(value));
function metadataEnvelope(binding: RecoveryCheckpointBinding, plan: RecoveryCheckpointPlan, metadata: RecoveryJson) {
  return { domain: ROOT_DOMAIN, version: 1, binding, plan, metadata };
}
async function rootHash(metadataSha256: string, chunks: readonly RecoveryCheckpointChunk[], byteLength: number,
  current: () => void): Promise<string> {
  let chain = metadataSha256;
  for (const chunk of chunks) {
    current();
    chain = await sha256(encode({ domain: `${ROOT_DOMAIN}/chunk`, previous: chain, ...chunk }));
    current();
  }
  const result = await sha256(encode({ domain: `${ROOT_DOMAIN}/root`, metadataSha256, chain, byteLength, chunkCount: chunks.length }));
  current(); return result;
}
function assertLease(ledger: ResourceLedger, lease: ResourceLease, bytes: number) {
  if (!ledger.owns(lease, 'recovery')) throw new AdmissionError('The recovery reservation belongs to another ledger or has retired.');
  assertResourceCredit(resourceLeaseCredit(lease), bytes);
}
function range(plan: RecoveryCheckpointPlan, index: number): RecoveryCheckpointRange | null {
  const offset = checkedBytes(index, plan.maximumChunkBytes);
  return offset >= plan.byteLength ? null : Object.freeze({ index, offset, length: Math.min(plan.maximumChunkBytes, plan.byteLength - offset) });
}
function assertRange(value: unknown, expected: RecoveryCheckpointRange | null): RecoveryCheckpointRange {
  const data = record(value, ['index', 'offset', 'length']);
  integer(data.index); integer(data.offset); integer(data.length, 1, MiB);
  if (!expected || data.index !== expected.index || data.offset !== expected.offset || data.length !== expected.length)
    throw invalid('sequential chunk range');
  return expected;
}

type Retention = {
  ledger: ResourceLedger; retained: ResourceLease; retainedBytes: number; workBytes: number;
  binding: RecoveryCheckpointBinding; plan: RecoveryCheckpointPlan; metadata: RecoveryJson;
  chunks: Uint8Array<ArrayBuffer>[]; records: RecoveryCheckpointChunk[];
};
function releaseRetention(retained: Retention) {
  // Retired owner/reader objects may themselves remain reachable. Drop private
  // backing storage before returning its reservation for another allocation.
  retained.chunks.length = 0;
  retained.retained();
}

/** Only one admitted incoming chunk is accepted at a time. Cancellation joins
 * an in-flight Web Crypto call before returning either reservation. Native
 * plan.workspaceBytes is intentionally NOT external/native-heap coverage.
 */
export class RecoveryCheckpointBuilder {
  readonly #binding: RecoveryCheckpointBinding;
  readonly #plan: RecoveryCheckpointPlan;
  #retention: Retention | null;
  readonly #work: ResourceLease;
  #pending: Promise<unknown> | null = null;
  #stopped = false;
  #finished = false;
  #released = false;
  readonly #hash = new IncrementalCheckpointHash();

  constructor(ledger: ResourceLedger, expected: unknown, binding: unknown, plan: unknown, metadata: unknown) {
    this.#binding = assertRecoveryCheckpointBinding(binding, expected);
    this.#plan = validateRecoveryCheckpointPlan(plan);
    if (this.#plan.currentSourceCount < this.#binding.subset.sourceCount)
      throw invalid('native original source count binding');
    const browser = jsonSnapshot(metadata);
    const envelope = jsonSnapshot(metadataEnvelope(this.#binding, this.#plan, browser.value));
    const encodedBytes = encode(envelope.value).byteLength;
    if (encodedBytes > MAX_METADATA_BYTES) throw invalid('canonical metadata bound');
    const metadataBytes = checkedBytes(encodedBytes * 3 + envelope.nodes * 96 + envelope.units * 2, 1);
    const sizes = estimateRecoveryCheckpointBytes(this.#plan.byteLength, this.#plan.maximumChunkBytes, metadataBytes);
    const retained = ledger.reserve('recovery', sizes.retainedBytes);
    try { this.#work = ledger.reserve('recovery', sizes.workBytes); }
    catch (error) { retained(); throw error; }
    this.#retention = { ledger, retained, retainedBytes: sizes.retainedBytes, workBytes: sizes.workBytes,
      binding: this.#binding, plan: this.#plan, metadata: browser.value, chunks: [], records: [] };
    Object.freeze(this);
  }
  get binding() { return this.#binding; }
  get plan() { return this.#plan; }
  get nextRange(): RecoveryCheckpointRange | null {
    this.#current(); return range(this.#plan, this.#retention!.chunks.length);
  }
  #current(): Retention {
    if (this.#stopped || this.#finished || !this.#retention) throw cancelled();
    assertLease(this.#retention.ledger, this.#retention.retained, this.#retention.retainedBytes);
    assertLease(this.#retention.ledger, this.#work, this.#retention.workBytes);
    return this.#retention;
  }
  #release() {
    if (this.#released) return;
    this.#released = true;
    if (this.#retention) { releaseRetention(this.#retention); this.#retention = null; }
    this.#work();
    this.#hash.dispose();
  }
  #operation<T>(work: () => Promise<T>): Promise<T> {
    if (this.#pending) return Promise.reject(invalid('outstanding chunk credit'));
    const task = Promise.resolve().then(work);
    const joined = task.finally(() => { this.#pending = null; if (this.#stopped) this.#release(); });
    this.#pending = joined;
    return joined;
  }
  append(requested: unknown, bytes: unknown): Promise<void> {
    let retained: Retention, expected: RecoveryCheckpointRange, copy: Uint8Array<ArrayBuffer>;
    try {
      retained = this.#current();
      if (this.#pending) throw invalid('outstanding chunk credit');
      expected = assertRange(requested, range(this.#plan, retained.chunks.length));
      const input = ownedBuffer(bytes, expected.length);
      // This happens before returning/yielding: caller aliases cannot change it.
      copy = new Uint8Array(new Uint8Array(input));
    } catch (error) { return Promise.reject(error); }
    return this.#operation(async () => {
      try {
        this.#current();
        const digest = await sha256(copy);
        this.#current();
        if (expected.index === 0) {
          assertHeader(copy, this.#plan);
          const headerDigest = await sha256(copy.slice(0, 64));
          this.#current();
          if (headerDigest !== this.#plan.headerSha256) throw invalid('native header integrity');
        }
        this.#hash.update(expected.index === 0 ? copy.subarray(64) : copy);
        retained.chunks.push(copy);
        retained.records.push(Object.freeze({ ...expected, sha256: digest }));
      } catch (error) { this.#stopped = true; throw error; }
    });
  }
  prepare(): Promise<PreparedRecoveryCheckpoint> {
    try {
      const retained = this.#current();
      if (this.#pending) throw invalid('outstanding chunk credit');
      if (range(this.#plan, retained.chunks.length)) throw invalid('incomplete payload');
      return this.#operation(async () => {
        try {
          this.#current();
          if (this.#hash.digest() !== this.#plan.sha256) throw invalid('native payload integrity');
          const metadataSha256 = await sha256(encode(metadataEnvelope(this.#binding, this.#plan, retained.metadata)));
          this.#current();
          const rootSha256 = await rootHash(metadataSha256, retained.records, this.#plan.byteLength, () => this.#current());
          this.#current();
          const description = Object.freeze({ version: 1 as const, binding: this.#binding, plan: this.#plan,
            metadata: retained.metadata, metadataSha256, rootSha256, chunks: Object.freeze(retained.records) });
          const prepared = new PreparedRecoveryCheckpoint(OWNER, retained, description);
          this.#finished = true; this.#retention = null; this.#release();
          return prepared;
        } catch (error) { this.#stopped = true; throw error; }
      });
    } catch (error) { return Promise.reject(error); }
  }
  async cancel(): Promise<void> {
    if (this.#finished) return;
    this.#stopped = true;
    await this.#pending?.catch(() => undefined);
    this.#release();
  }
}

/** Prepared ownership is deliberately separate from accepted recovery state.
 * Aborting a candidate cannot retire a previously accepted snapshot.
 */
export class PreparedRecoveryCheckpoint {
  #retained: Retention | null;
  readonly #description: RecoveryCheckpointDescription;
  constructor(token: typeof OWNER, retained: Retention, description: RecoveryCheckpointDescription) {
    if (token !== OWNER) throw invalid('prepared owner');
    this.#retained = retained; this.#description = description;
    Object.freeze(this);
  }
  get description() { return this.#description; }
  accept(expectedLedger?: ResourceLedger): RecoveryCheckpointSnapshot {
    if (!this.#retained) throw invalid('retired prepared owner');
    if (expectedLedger !== undefined && expectedLedger !== this.#retained.ledger)
      throw new AdmissionError('A recovery checkpoint cannot borrow another ledger\'s credit.');
    assertLease(this.#retained.ledger, this.#retained.retained, this.#retained.retainedBytes);
    const value = new RecoveryCheckpointSnapshot(OWNER, this.#retained, this.#description);
    this.#retained = null;
    return value;
  }
  abort(): void {
    if (this.#retained) { releaseRetention(this.#retained); this.#retained = null; }
  }
}

/** A read is a fresh, independently admitted transfer copy. release() means
 * its receiver has joined; it detaches a still-local copy so its credit cannot
 * be reused while a caller retains readable bytes. The private snapshot is
 * never transferred. A reader's cancellation waits for this explicit release.
 */
export type RecoveryCheckpointRead = RecoveryCheckpointRange & Readonly<{
  bytes: ArrayBuffer; release(): void;
}>;

export class RecoveryCheckpointSnapshot {
  #owned = true;
  #reading = false;
  #references = 1;
  readonly #retained: Retention;
  readonly #description: RecoveryCheckpointDescription;
  constructor(token: typeof OWNER, retained: Retention, description: RecoveryCheckpointDescription) {
    if (token !== OWNER) throw invalid('snapshot owner');
    this.#retained = retained; this.#description = description;
    Object.freeze(this);
  }
  get description() { return this.#description; }
  get retainedBytes() { return this.#retained.retainedBytes; }
  release(): void {
    if (!this.#owned) return;
    this.#owned = false; this.#drop();
  }
  #drop() {
    if (--this.#references === 0) releaseRetention(this.#retained);
  }
  async openRestore(expected: unknown, ledger: ResourceLedger, signal?: AbortSignal): Promise<RecoveryCheckpointReader> {
    if (!this.#owned) throw invalid('released snapshot');
    assertRecoveryCheckpointBinding(this.#description.binding, expected);
    if (ledger !== this.#retained.ledger) throw new AdmissionError('A recovery snapshot cannot borrow another ledger\'s credit.');
    if (this.#reading) throw invalid('outstanding restore reader');
    if (signal !== undefined) {
      let aborted: boolean;
      try { aborted = signalAborted.call(signal); } catch { throw invalid('abort signal'); }
      if (aborted) throw cancelled();
    }
    assertLease(ledger, this.#retained.retained, this.#retained.retainedBytes);
    const work = ledger.reserve('recovery', this.#retained.workBytes);
    this.#reading = true; this.#references++;
    let removeAbort: () => void = () => undefined;
    const reader = new RecoveryCheckpointReader(OWNER, this.#retained, this.#description, work, () => {
      removeAbort(); this.#reading = false; this.#drop();
    });
    if (signal) {
      const abort = () => { void reader.cancel(); };
      EventTarget.prototype.addEventListener.call(signal, 'abort', abort, { once: true });
      removeAbort = () => EventTarget.prototype.removeEventListener.call(signal, 'abort', abort);
      if (signalAborted.call(signal)) abort();
    }
    try { await reader.verify(); return reader; }
    catch (error) { await reader.cancel(); throw error; }
  }
}

export class RecoveryCheckpointReader {
  #next = 0;
  #closed = false;
  #verified = false;
  #pending: Promise<unknown> | null = null;
  #held: Promise<void> | null = null;
  #closing: Promise<void> | null = null;
  readonly #retained: Retention;
  readonly #description: RecoveryCheckpointDescription;
  readonly #work: ResourceLease;
  readonly #joined: () => void;
  constructor(token: typeof OWNER, retained: Retention, description: RecoveryCheckpointDescription,
    work: ResourceLease, joined: () => void) {
    if (token !== OWNER) throw invalid('reader owner');
    this.#retained = retained; this.#description = description; this.#work = work; this.#joined = joined;
    Object.freeze(this);
  }
  get description() { return this.#description; }
  #current() {
    if (this.#closed) throw cancelled();
    assertLease(this.#retained.ledger, this.#retained.retained, this.#retained.retainedBytes);
    assertLease(this.#retained.ledger, this.#work, this.#retained.workBytes);
  }
  #operation<T>(work: () => Promise<T>): Promise<T> {
    if (this.#pending || this.#held) return Promise.reject(invalid('outstanding restore chunk credit'));
    const task = Promise.resolve().then(work);
    const joined = task.finally(() => { this.#pending = null; });
    this.#pending = joined; return joined;
  }
  /** Called by the owning snapshot before any bytes can be imported. */
  verify(): Promise<void> {
    return this.#operation(async () => {
      this.#current();
      const { binding, plan, metadata, chunks, metadataSha256, rootSha256 } = this.#description;
      const actualMetadata = await sha256(encode(metadataEnvelope(binding, plan, metadata)));
      this.#current();
      if (actualMetadata !== metadataSha256 || chunks.length !== this.#retained.chunks.length)
        throw invalid('metadata integrity');
      for (let index = 0; index < chunks.length; index++) {
        const expected = range(plan, index);
        const chunk = chunks[index];
        if (!expected || chunk.index !== expected.index || chunk.offset !== expected.offset || chunk.length !== expected.length ||
            !HASH.test(chunk.sha256) || ownedBuffer(this.#retained.chunks[index].buffer, expected.length) !== this.#retained.chunks[index].buffer)
          throw invalid('retained chunk inventory');
        const actual = await sha256(this.#retained.chunks[index]);
        this.#current();
        if (actual !== chunk.sha256) throw invalid('chunk integrity');
      }
      if (range(plan, chunks.length)) throw invalid('retained payload length');
      const actualRoot = await rootHash(actualMetadata, chunks, plan.byteLength, () => this.#current());
      this.#current();
      if (actualRoot !== rootSha256) throw invalid('root integrity');
      this.#verified = true;
    });
  }
  get nextRange(): RecoveryCheckpointRange | null {
    this.#current();
    if (!this.#verified) throw invalid('unverified restore');
    return range(this.#retained.plan, this.#next);
  }
  read(requested: unknown): Promise<RecoveryCheckpointRead> {
    let expected: RecoveryCheckpointRange;
    try {
      this.#current();
      if (!this.#verified) throw invalid('unverified restore');
      if (this.#pending || this.#held) throw invalid('outstanding restore chunk credit');
      expected = assertRange(requested, range(this.#retained.plan, this.#next));
    } catch (error) { return Promise.reject(error); }
    return this.#operation(async () => {
      this.#current();
      const copy = new Uint8Array(this.#retained.chunks[expected.index]);
      const actual = await sha256(copy);
      this.#current();
      if (actual !== this.#description.chunks[expected.index].sha256) throw invalid('restore copy integrity');
      let retire!: () => void;
      const held = new Promise<void>(resolve => { retire = resolve; });
      this.#held = held; this.#next++;
      let released = false;
      const release = () => {
        if (released) return;
        // Transferred copies are already detached. Otherwise detach explicitly;
        // a failed detachment preserves the held credit and can be retried.
        try { new Uint8Array(copy.buffer); structuredClone(copy.buffer, { transfer: [copy.buffer] }); }
        catch (error) {
          try { new Uint8Array(copy.buffer); } catch { /* Already transferred. */ released = true; }
          if (!released) throw error;
        }
        released = true;
        if (this.#held === held) this.#held = null;
        retire();
      };
      return Object.freeze({ ...expected, bytes: copy.buffer, release });
    });
  }
  /** A successful import joins its final copy before finishing. This does not
   * declare that the replacement worker committed the imported native graph.
   */
  finish(): Promise<void> {
    if (!this.#verified || this.#next !== this.#description.chunks.length || this.#held || this.#pending)
      return Promise.reject(invalid('incomplete restore read'));
    return this.cancel();
  }
  cancel(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#closing = (async () => {
      await this.#pending?.catch(() => undefined);
      await this.#held;
      this.#work(); this.#joined();
    })();
    return this.#closing;
  }
}
