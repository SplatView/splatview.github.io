import { assertResourceCredit, bindResourceLeaseCredit, resourceCreditBytes, resourceLeaseCredit,
  type ResourceCredit, type ResourceLease } from '../document/resources';
import { synchronousSourceHook } from '../document/source';
import { assertPreparedSogMetadata, type OwnedSogMetadataBytes, type PreparedSogMetadata, type SogGroup } from './sogMetadata';
import { prepareSogResources, type PreparedSogCatalog, type PreparedSogResource, type PreparedSogResources,
  type SogResourceBinding, type SogResourceOptions } from './sogResources';

export const MAX_SOG_DECODER_METADATA_BYTES = 16 * 1024 * 1024;
export const MAX_SOG_DECODER_SEGMENT_BYTES = 1024 * 1024;
export type SogDecoderResource = Readonly<PreparedSogResource & { decoderName: string }>;
export type SogDecoderBinding = Readonly<SogResourceBinding & { decoderName: string }>;
export type SogDecoderMetadataOptions = SogResourceOptions & {
  /** admit may return a genuine ResourceLedger lease unchanged, or an arbitrary
   * cleanup/resize wrapper explicitly registered by bindResourceLeaseCredit.
   * Caller getters are still audited, but never serve as the final authority. */
  /** Tighten the frozen native metadata ceiling, never increase it. */
  maxDecoderBytes?: number;
};
export type PreparedSogDecoderMetadata = Readonly<{
  readonly originalByteLength: number;
  readonly byteLength: number;
  readonly version: 1 | 2;
  readonly sourceCount: number;
  readonly shDegree: 0 | 1 | 2 | 3 | null;
  readonly primaryResourceId: string;
  readonly totalBytes: number;
  readonly resources: readonly SogDecoderResource[];
  readonly bindings: readonly SogDecoderBinding[];
  /** Retained owner allowance, excluding the separately owned original M bytes. */
  readonly preparationBytes: number;
  assertCurrent(): void;
  /** Owned segments are valid for synchronous consumption/transfer. The caller
   * must admit any retained segment or destination independently. Neither stream
   * exposes the private original buffer; segment boundaries may split UTF-8. */
  writeOriginal(consume: (bytes: Uint8Array) => unknown, maxSegmentBytes?: number): number;
  writeDecoder(consume: (bytes: Uint8Array) => unknown, maxSegmentBytes?: number): number;
  dispose(): void;
}>;

const GROUPS: readonly SogGroup[] = ['means', 'scales', 'quats', 'sh0', 'shN'];
const BASE_BYTES = 64 * 1024;
type Span = { start: number; end: number };
type Replacement = Span & { decoderName: string };
const whitespace = (byte: number | undefined): boolean => byte === 9 || byte === 10 || byte === 13 || byte === 32;

function fail(message: string): never { throw new Error(`SOG decoder metadata: ${message}`); }
function add(...values: number[]): number {
  let total = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0 || !Number.isSafeInteger(total + value)) fail('size overflow');
    total += value;
  }
  return total;
}
function outputLimit(value: unknown): number {
  if (value === undefined) return MAX_SOG_DECODER_METADATA_BYTES;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_SOG_DECODER_METADATA_BYTES)
    fail('decoder byte limit may only tighten the native ceiling');
  return value;
}

/** A lexical cursor over bytes already authenticated by the bounded parser.
 * Unknown values are skipped iteratively. Only root group keys, group files keys
 * and at most eight final string spans per group are retained. No second DOM,
 * whole decoded string or whole serialized output is materialized. */
class Cursor {
  index = 0;
  constructor(readonly bytes: Uint8Array) {
    // TextDecoder's accepted UTF-8 BOM is retained verbatim in both streams.
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) this.index = 3;
  }
  space(): void {
    while (whitespace(this.bytes[this.index])) this.index++;
  }
  expect(byte: number): void {
    this.space();
    if (this.bytes[this.index++] !== byte) fail('authenticated JSON cursor mismatch');
  }
  string(): Span {
    this.space(); const start = this.index;
    if (this.bytes[this.index++] !== 34) fail('expected authenticated string');
    while (this.index < this.bytes.length) {
      const byte = this.bytes[this.index++]!;
      if (byte === 34) return { start, end: this.index };
      if (byte === 92) {
        if (this.bytes[this.index++] === 117) this.index += 4;
      }
    }
    return fail('unterminated authenticated string');
  }
  skip(): void {
    this.space();
    if (this.bytes[this.index] === 34) { this.string(); return; }
    const first = this.bytes[this.index];
    if (first === 123 || first === 91) {
      let depth = 0;
      while (this.index < this.bytes.length) {
        const byte = this.bytes[this.index];
        if (byte === 34) { this.string(); continue; }
        this.index++;
        if (byte === 123 || byte === 91) {
          if (++depth > 32) fail('authenticated depth changed');
        } else if ((byte === 125 || byte === 93) && --depth === 0) return;
      }
      fail('unterminated authenticated value');
    }
    const start = this.index;
    while (this.index < this.bytes.length && !whitespace(this.bytes[this.index]) &&
      this.bytes[this.index] !== 44 && this.bytes[this.index] !== 93 && this.bytes[this.index] !== 125) this.index++;
    if (this.index === start) fail('empty authenticated value');
  }
  files(): Span[] | undefined {
    this.space();
    if (this.bytes[this.index] !== 91) { this.skip(); return undefined; }
    this.index++; this.space();
    const spans: Span[] = []; let valid = true, count = 0;
    if (this.bytes[this.index] === 93) { this.index++; return spans; }
    while (true) {
      this.space(); count++;
      if (this.bytes[this.index] === 34) {
        const span = this.string();
        if (count <= 8) spans.push(span); else valid = false;
      } else { this.skip(); valid = false; }
      this.space();
      if (this.bytes[this.index] === 93) { this.index++; return valid ? spans : undefined; }
      this.expect(44);
    }
  }
  group(): Span[] | undefined {
    this.space();
    if (this.bytes[this.index] !== 123) { this.skip(); return undefined; }
    this.index++; this.space();
    let files: Span[] | undefined;
    if (this.bytes[this.index] === 125) { this.index++; return undefined; }
    while (true) {
      const key = this.string(); this.expect(58);
      if (stringEquals(this.bytes, key, 'files')) files = this.files(); else this.skip();
      this.space();
      if (this.bytes[this.index] === 125) { this.index++; return files; }
      this.expect(44);
    }
  }
  groups(): Map<SogGroup, Span[] | undefined> {
    this.expect(123); const groups = new Map<SogGroup, Span[] | undefined>(); this.space();
    if (this.bytes[this.index] === 125) { this.index++; return groups; }
    while (true) {
      const key = this.string(); this.expect(58);
      const group = GROUPS.find(name => stringEquals(this.bytes, key, name));
      if (group) groups.set(group, this.group()); else this.skip();
      this.space();
      if (this.bytes[this.index] === 125) { this.index++; this.space(); break; }
      this.expect(44);
    }
    if (this.index !== this.bytes.length) fail('trailing authenticated data');
    return groups;
  }
}

/** Compare a JSON string to UTF-16 without allocating a decoded reference. */
function stringEquals(bytes: Uint8Array, span: Span, expected: string): boolean {
  let index = span.start + 1, unit = 0;
  const take = (value: number): boolean => unit < expected.length && expected.charCodeAt(unit++) === value;
  const hex = (byte: number): number => byte <= 57 ? byte - 48 : byte <= 70 ? byte - 55 : byte - 87;
  while (index < span.end - 1) {
    let point = bytes[index++]!;
    if (point === 92) {
      const escape = bytes[index++]!;
      if (escape === 117) {
        point = 0;
        for (let digit = 0; digit < 4; digit++) point = point * 16 + hex(bytes[index++]!);
      } else {
        const escapes: Record<number, number> = { 34: 34, 92: 92, 47: 47, 98: 8, 102: 12, 110: 10, 114: 13, 116: 9 };
        point = escapes[escape]!;
      }
    } else if (point >= 0xc0) {
      const continuation = point < 0xe0 ? 1 : point < 0xf0 ? 2 : 3;
      point &= continuation === 1 ? 31 : continuation === 2 ? 15 : 7;
      for (let next = 0; next < continuation; next++) point = point * 64 + (bytes[index++]! & 63);
    }
    if (point > 0xffff) {
      point -= 0x10000;
      if (!take(0xd800 + (point >> 10)) || !take(0xdc00 + (point & 1023))) return false;
    } else if (!take(point)) return false;
  }
  return unit === expected.length;
}

/** Authenticate a parser/catalog pair through the existing graph factory. After
 * construction this owner is independent: original M-byte copy, frozen complete
 * descriptors and replacement spans remain charged until dispose. Preparation
 * keeps the parents alive through every fallible snapshot/cursor step. */
export function prepareSogDecoderMetadata(
  metadata: PreparedSogMetadata, primaryPath: string, catalog: PreparedSogCatalog,
  options: SogDecoderMetadataOptions,
): PreparedSogDecoderMetadata {
  if (!options || typeof options !== 'object' || Array.isArray(options)) fail('missing ownership hooks');
  const admit = options.admit, current = options.current, limit = outputLimit(options.maxDecoderBytes);
  if (typeof admit !== 'function' || typeof current !== 'function') fail('invalid ownership hooks');
  type Admission = { raw: ResourceLease; credit: ResourceCredit; bytes: number; live: boolean };
  const issued = new WeakSet<ResourceLease>(), credits = new WeakSet<ResourceCredit>();
  const admissions = new Map<ResourceCredit, Admission>(), owned = new Map<ResourceLease, number>();
  let graph: PreparedSogResources | undefined, original: OwnedSogMetadataBytes | undefined;
  let resources: readonly SogDecoderResource[] | undefined, bindings: readonly SogDecoderBinding[] | undefined;
  let replacements: readonly Replacement[] | undefined;
  let closed = false, writing = false, cleaned = false;
  function alive(): void { if (closed || cleaned) fail('owner is disposed'); }
  function creditBarrier(): void {
    // No caller code/getters from this point through the next allocation/copy.
    for (const entry of admissions.values()) assertResourceCredit(entry.credit, entry.bytes);
    alive();
  }
  const configured: SogResourceOptions = {
    admit(bytes) {
      const value = Reflect.apply(admit, options, [bytes]) as ResourceLease;
      if (typeof value !== 'function') return value;
      if (issued.has(value)) fail('admission reused an owned lease');
      issued.add(value);
      let credit: ResourceCredit;
      try { credit = resourceLeaseCredit(value); }
      catch (error) {
        try { synchronousSourceHook(value()); }
        catch (cleanup) { throw new AggregateError([error, cleanup], 'Unbound SOG admission cleanup failed.'); }
        throw error;
      }
      // A second cleanup wrapper cannot acquire credit already handed to a
      // subowner. Do not release it: that would steal the first owner's credit.
      if (credits.has(credit)) fail('admission reused an owned credit');
      let entry: Admission | undefined;
      try {
        synchronousSourceHook(value);
        const observed = value.bytes; synchronousSourceHook(observed);
        const resize = value.resize; synchronousSourceHook(resize);
        if (observed !== bytes || typeof resize !== 'function') fail('invalid admission credit');
        assertResourceCredit(credit, bytes); creditBarrier();
        const lease = (() => {
          if (!entry!.live) return;
          entry!.live = false;
          admissions.delete(credit);
          synchronousSourceHook(value());
          if (resourceCreditBytes(credit) !== undefined) fail('release did not retire its authenticated credit');
        }) as ResourceLease;
        // Subowners must not call arbitrary wrapper getters between their own
        // final ownership checks and materialization. The raw getter remains
        // checked at admission and at every public owner audit below.
        Object.defineProperty(lease, 'bytes', { get: () => resourceCreditBytes(credit) ?? 0 });
        lease.resize = amount => {
          if (!entry!.live) fail('admission is retired');
          synchronousSourceHook(Reflect.apply(resize, value, [amount]));
          assertResourceCredit(credit, amount);
          entry!.bytes = amount;
          creditBarrier();
        };
        bindResourceLeaseCredit(lease, value);
        entry = { raw: value, credit, bytes, live: true };
        admissions.set(credit, entry); credits.add(credit);
        return lease;
      } catch (error) {
        try { synchronousSourceHook(value()); }
        catch (cleanup) { throw new AggregateError([error, cleanup], 'SOG admission cleanup failed.'); }
        throw error;
      }
    },
    current() { synchronousSourceHook(Reflect.apply(current, options, [])); creditBarrier(); },
  };
  function reserve(bytes: number): ResourceLease {
    const lease = configured.admit(bytes);
    if (typeof lease !== 'function') { synchronousSourceHook(lease); fail('invalid admission lease'); }
    owned.set(lease, bytes);
    try {
      synchronousSourceHook(lease);
      if (lease.bytes !== bytes || typeof lease.resize !== 'function') fail('invalid admission credit');
      return lease;
    } catch (error) {
      try { release(lease); } catch (cleanup) { throw new AggregateError([error, cleanup], 'SOG admission cleanup failed.'); }
      throw error;
    }
  }
  function release(lease: ResourceLease): void {
    if (owned.delete(lease)) synchronousSourceHook(lease());
  }
  function assertCurrent(): Uint8Array | undefined {
    alive();
    // The independent copy audits its own credit before/after this current hook.
    const bytes = original ? original.bytes : (configured.current(), undefined);
    for (const entry of admissions.values()) {
      const observed = entry.raw.bytes; synchronousSourceHook(observed);
      if (observed !== entry.bytes) fail('retained admission credit changed');
    }
    creditBarrier(); return bytes;
  }
  function parents(): void { assertCurrent(); graph!.assertCurrent(); creditBarrier(); }
  function cleanup(): void {
    if (cleaned) return;
    cleaned = true;
    resources = undefined; bindings = undefined; replacements = undefined;
    const errors: unknown[] = [];
    const previousGraph = graph; graph = undefined;
    const previousOriginal = original; original = undefined;
    try { previousGraph?.dispose(); } catch (error) { errors.push(error); }
    try { previousOriginal?.dispose(); } catch (error) { errors.push(error); }
    for (const lease of [...owned.keys()]) { try { release(lease); } catch (error) { errors.push(error); } }
    if (errors.length) throw new AggregateError(errors, 'SOG metadata retirement failed.');
  }
  function dispose(): void { if (closed) return; closed = true; if (!writing) cleanup(); }

  try {
    assertPreparedSogMetadata(metadata); configured.current();
    graph = prepareSogResources(metadata, primaryPath, catalog, configured); parents();
    const sourceResources = graph.resources, sourceBindings = graph.bindings;
    const M = metadata.byteLength, version = metadata.version, sourceCount = metadata.sourceCount, shDegree = metadata.shDegree;
    const primaryResourceId = graph.primaryResourceId, totalBytes = graph.totalBytes;
    let units = 0;
    for (const entry of sourceResources) units = add(units, entry.resourceId.length, entry.acquisitionPath.length, entry.fingerprintPath.length, 16);
    for (const entry of sourceBindings) units = add(units, entry.group.length, entry.reference.length, entry.resourceId.length,
      entry.acquisitionPath.length, entry.fingerprintPath.length, 16);
    const preparationBytes = add(BASE_BYTES, 256 * (sourceResources.length + sourceBindings.length), 2 * units);
    reserve(preparationBytes); parents();
    original = metadata.copyOriginal(configured); parents();
    const names = new Map<string, string>(); let nextName = 0;
    resources = Object.freeze(sourceResources.map(entry => {
      const decoderName = entry.role === 'primary' ? 'meta.json' : `r${String(nextName++).padStart(4, '0')}.webp`;
      names.set(entry.resourceId, decoderName);
      return Object.freeze({ ...entry, decoderName });
    }));
    bindings = Object.freeze(sourceBindings.map(entry => {
      const decoderName = names.get(entry.resourceId);
      if (!decoderName || decoderName === 'meta.json') fail('binding has no admitted texture');
      return Object.freeze({ ...entry, decoderName });
    }));
    parents();
    const originalBytes = assertCurrent()!, spans = new Cursor(originalBytes).groups();
    const edits: Replacement[] = []; let byteLength = M;
    for (const group of GROUPS) {
      const entries = bindings.filter(binding => binding.group === group), groupSpans = spans.get(group);
      if ((groupSpans?.length ?? 0) !== entries.length) fail('authenticated declaration positions changed');
      for (const binding of entries) {
        const span = groupSpans![binding.index];
        if (!span || !stringEquals(originalBytes, span, binding.reference)) fail('original reference binding changed');
        byteLength = add(byteLength - (span.end - span.start), binding.decoderName.length + 2);
        edits.push(Object.freeze({ ...span, decoderName: binding.decoderName }));
      }
    }
    if (byteLength > limit) fail('rewritten metadata exceeds decoder byte limit');
    edits.sort((left, right) => left.start - right.start);
    let previousEnd = 0;
    for (const edit of edits) {
      if (edit.start < previousEnd || edit.end > M || edit.start >= edit.end) fail('overlapping original reference spans');
      previousEnd = edit.end;
    }
    replacements = Object.freeze(edits); parents();
    const previousGraph = graph; graph = undefined; previousGraph.dispose();
    assertCurrent();

    function write(decoder: boolean, consume: (bytes: Uint8Array) => unknown, maxSegmentBytes = MAX_SOG_DECODER_SEGMENT_BYTES): number {
      if (typeof consume !== 'function' || !Number.isSafeInteger(maxSegmentBytes) || maxSegmentBytes < 1 ||
          maxSegmentBytes > MAX_SOG_DECODER_SEGMENT_BYTES) fail('invalid synchronous segment consumer or size');
      alive(); if (writing) fail('reentrant metadata emission');
      writing = true;
      let work: ResourceLease | undefined, error: unknown, failed = false;
      try {
        assertCurrent();
        const expected = decoder ? byteLength : M, capacity = Math.min(expected, maxSegmentBytes);
        work = reserve(add(capacity, capacity));
        const input = assertCurrent()!;
        let output: Uint8Array | undefined, used = 0, written = 0;
        function ready(): void {
          if (written >= expected) fail('output exceeds its exact length');
          creditBarrier();
          if (!output) output = new Uint8Array(Math.min(capacity, expected - written));
        }
        function flush(): void {
          if (!output || used !== output.length) fail('incomplete output segment');
          written += used;
          creditBarrier();
          synchronousSourceHook(consume(output));
          output = undefined; used = 0; assertCurrent();
        }
        function copy(start: number, end: number): void {
          while (start < end) {
            ready(); const count = Math.min(end - start, output!.length - used);
            output!.set(input.subarray(start, start + count), used); used += count; start += count;
            if (used === output!.length) flush();
          }
        }
        function ascii(value: string): void {
          for (let index = 0; index < value.length; index++) {
            ready(); output![used++] = value.charCodeAt(index);
            if (used === output!.length) flush();
          }
        }
        if (decoder) {
          let offset = 0;
          for (const edit of replacements!) {
            copy(offset, edit.start); ascii('"'); ascii(edit.decoderName); ascii('"'); offset = edit.end;
          }
          copy(offset, M);
        } else copy(0, M);
        if (output || used || written !== expected) fail('output byte count mismatch');
        assertCurrent(); return written;
      } catch (value) { error = value; failed = true; throw value; }
      finally {
        const errors: unknown[] = [];
        try { if (work) release(work); } catch (value) { errors.push(value); }
        writing = false;
        try { if (closed) cleanup(); } catch (value) { errors.push(value); }
        if (errors.length) throw new AggregateError(failed ? [error, ...errors] : errors, 'SOG metadata emission cleanup failed.');
      }
    }
    return Object.freeze({
      get originalByteLength() { assertCurrent(); return M; },
      get byteLength() { assertCurrent(); return byteLength; },
      get version() { assertCurrent(); return version; },
      get sourceCount() { assertCurrent(); return sourceCount; },
      get shDegree() { assertCurrent(); return shDegree; },
      get primaryResourceId() { assertCurrent(); return primaryResourceId; },
      get totalBytes() { assertCurrent(); return totalBytes; },
      get resources() { assertCurrent(); return resources!; },
      get bindings() { assertCurrent(); return bindings!; },
      get preparationBytes() { assertCurrent(); return preparationBytes; },
      assertCurrent() { assertCurrent(); },
      writeOriginal(consume: (bytes: Uint8Array) => unknown, maxSegmentBytes?: number) { return write(false, consume, maxSegmentBytes); },
      writeDecoder(consume: (bytes: Uint8Array) => unknown, maxSegmentBytes?: number) { return write(true, consume, maxSegmentBytes); },
      dispose,
    });
  } catch (error) {
    closed = true;
    try { cleanup(); } catch (retirement) { throw new AggregateError([error, retirement], 'SOG metadata preparation cleanup failed.'); }
    throw error;
  }
}
