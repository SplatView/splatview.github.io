import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertResourceCredit, bindResourceLeaseCredit, resourceCreditBytes, resourceLeaseCredit,
  ResourceLedger, type ResourceCredit, type ResourceLease } from '../src/document/resources';
import { parseSogMetadata, type PreparedSogMetadata } from '../src/io/sogMetadata';
import { prepareSogCatalog, type AcquiredSogResource, type PreparedSogCatalog } from '../src/io/sogResources';
import { MAX_SOG_DECODER_METADATA_BYTES, MAX_SOG_DECODER_SEGMENT_BYTES, prepareSogDecoderMetadata,
  type PreparedSogDecoderMetadata, type SogDecoderMetadataOptions } from '../src/io/sogDecoderMetadata';

// Handwritten oracle: order follows original canonical UTF-8 paths, independent
// of JSON property order, acquisition order and declaration order.
const V2 = '{"version":2,"count":3,"means":{"files":["low.webp","high.webp"],"mins":[0,0,0],"maxs":[1,2,3]},"scales":{"files":["scale.webp"],"codebook":[0]},"quats":{"files":["rotation.webp"]},"sh0":{"files":["color.webp"],"codebook":[0]}}';
const DECODER_V2 = '{"version":2,"count":3,"means":{"files":["r0002.webp","r0001.webp"],"mins":[0,0,0],"maxs":[1,2,3]},"scales":{"files":["r0004.webp"],"codebook":[0]},"quats":{"files":["r0003.webp"]},"sh0":{"files":["r0000.webp"],"codebook":[0]}}';
const V1 = '{"means":{"shape":[3,3],"files":["low.webp","high.webp"],"mins":[0,0,0],"maxs":[1,2,3]},"scales":{"files":["scale.webp"],"mins":[-1,-2,-3],"maxs":[1,2,3]},"quats":{"files":["rotation.webp"]},"sh0":{"files":["color.webp"],"mins":[0,0,0,-1],"maxs":[1,1,1,2]}}';
const encode = (text: string) => new TextEncoder().encode(text);
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const BASE = 'collection/asset/';
const PATHS = ['low.webp', 'high.webp', 'scale.webp', 'rotation.webp', 'color.webp'];
type LeaseRecord = { lease: ResourceLease; actual: ResourceLease; amount: number; calls: number };
type Account = { ledger: ResourceLedger; records: LeaseRecord[]; admit(amount: number): ResourceLease };
const cleanups: (() => void)[] = [];
const accounts: Account[] = [];
function account(): Account {
  const ledger = new ResourceLedger(256 * 1024 * 1024), records: LeaseRecord[] = [];
  const admit = (amount: number): ResourceLease => {
    const actual = ledger.reserve('source', amount);
    const record = { amount, actual, calls: 0 } as LeaseRecord;
    const lease = (() => { record.calls++; actual(); }) as ResourceLease;
    Object.defineProperty(lease, 'bytes', { get: () => actual.bytes, configurable: true });
    lease.resize = next => actual.resize(next); record.lease = lease; records.push(record);
    return bindResourceLeaseCredit(lease, actual);
  };
  const result = { ledger, records, admit }; accounts.push(result); return result;
}
function fixture(text = V2, extra: readonly AcquiredSogResource[] = [], parentCurrent = () => undefined) {
  const item = account(), bytes = encode(text);
  const metadata = parseSogMetadata(bytes, { admit: item.admit, current: parentCurrent });
  const catalog = prepareSogCatalog([
    { resourceId: 'metadata', acquisitionPath: BASE + 'meta.json', byteLength: bytes.length },
    ...PATHS.map((name, index) => ({ resourceId: name, acquisitionPath: BASE + name, byteLength: index + 11 })),
    ...extra,
  ], { admit: item.admit, current: parentCurrent });
  cleanups.push(() => metadata.dispose(), () => catalog.dispose());
  const prepare = (options: Partial<SogDecoderMetadataOptions> = {}) => {
    const owner = prepareSogDecoderMetadata(metadata, BASE + 'meta.json', catalog, { admit: item.admit,
      current: () => undefined, ...options }); cleanups.push(() => owner.dispose()); return owner;
  };
  return { ...item, bytes, metadata, catalog, prepare };
}
function collect(owner: PreparedSogDecoderMetadata, decoder = true, capacity?: number): Uint8Array {
  const segments: Uint8Array[] = [];
  const written = (decoder ? owner.writeDecoder : owner.writeOriginal)(segment => { segments.push(segment); }, capacity);
  const bytes = Uint8Array.from(Buffer.concat(segments)); expect(bytes.length).toBe(written); return bytes;
}
const textOf = (owner: PreparedSogDecoderMetadata, capacity?: number) => new TextDecoder('utf-8', { fatal: true }).decode(collect(owner, true, capacity));
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  for (const item of accounts.splice(0)) {
    expect(item.records.filter(record => record.calls !== 1)).toEqual([]);
    expect(item.ledger.usage.bytes).toBe(0); expect(item.ledger.usage.allocations).toBe(0);
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('factory-authenticated read-only credit boundary', () => {
  it.each(['decoder-bytes', 'decoder-resize', 'parser-bytes', 'parser-resize', 'catalog-bytes', 'catalog-resize'] as const)(
    'observes a rejected promise from malformed %s getter and releases the refused admission', async subject => {
      const decoder = subject.startsWith('decoder') ? fixture() : undefined;
      const item = decoder ?? account(), before = item.ledger.usage.bytes;
      const field = subject.endsWith('bytes') ? 'bytes' : 'resize';
      const options = { current() {}, admit(bytes: number) {
        const lease = item.admit(bytes);
        Object.defineProperty(lease, field, { get: () => Promise.reject(new Error('malformed async property')) });
        return lease;
      } };
      expect(() => {
        if (decoder) return decoder.prepare(options);
        if (subject.startsWith('parser')) return parseSogMetadata(encode(V2), options);
        return prepareSogCatalog([{ resourceId: 'm', acquisitionPath: 'meta.json', byteLength: 1 }], options);
      }).toThrow(/synchronous/);
      await Promise.resolve(); await Promise.resolve(); expect(item.ledger.usage.bytes).toBe(before);
    });

  it.each(['decoder', 'parser', 'catalog'] as const)(
    'observes a late rejected bytes getter before a %s accessor returns', async subject => {
      const item = fixture(), first = item.records.length;
      const owner = subject === 'decoder' ? item.prepare() : undefined;
      const catalogBytes = item.catalog.stats.catalogBytes;
      const record = subject === 'decoder' ? item.records[first + 1]! : subject === 'parser' ? item.records[0]! :
        item.records.find(entry => entry.actual.bytes === catalogBytes)!;
      Object.defineProperty(record.lease, 'bytes', { get: () => Promise.reject(new Error('late async property')) });
      expect(() => subject === 'decoder' ? owner!.resources : subject === 'parser' ? item.metadata.version :
        item.catalog.resourceCount).toThrow(/synchronous/);
      await Promise.resolve(); await Promise.resolve();
    });

  it('observes a late rejected independent-copy getter without publishing bytes', async () => {
    const item = fixture(); let copyLease: ResourceLease | undefined;
    const copy = item.metadata.copyOriginal({ current() {}, admit(bytes) { copyLease = item.admit(bytes); return copyLease; } });
    cleanups.push(() => copy.dispose());
    Object.defineProperty(copyLease!, 'bytes', { get: () => Promise.reject(new Error('late copy property')) });
    expect(() => copy.bytes).toThrow(/synchronous/); await Promise.resolve(); await Promise.resolve();
  });

  it('observes genuine live, resized and retired credits without invoking wrapper getters', () => {
    const item = account(), lease = item.admit(17), record = item.records[0]!;
    cleanups.push(() => lease());
    const credit = resourceLeaseCredit(lease);
    expect(credit).toBe(resourceLeaseCredit(record.actual)); expect(Object.isFrozen(credit)).toBe(true);
    Object.defineProperty(lease, 'bytes', { get() { throw new Error('untrusted getter must not run'); } });
    expect(resourceCreditBytes(credit)).toBe(17); assertResourceCredit(credit, 17);
    record.actual.resize(9); expect(resourceCreditBytes(credit)).toBe(9);
    expect(() => assertResourceCredit(credit, 17)).toThrow(/credit/);
    record.actual(); expect(resourceCreditBytes(credit)).toBeUndefined();
    expect(() => assertResourceCredit(credit, 0)).toThrow(/credit/);
  });
  it('distinguishes a live zero-byte reservation from retired zero bytes', () => {
    const item = account(), lease = item.admit(0); cleanups.push(() => lease());
    const credit = resourceLeaseCredit(lease); assertResourceCredit(credit, 0);
    item.records[0]!.actual(); expect(() => assertResourceCredit(credit, 0)).toThrow(/credit/);
  });
  it('refuses forged capabilities, unbound leases and rebinding across real reservations', () => {
    const item = account(), first = item.admit(3), second = item.admit(4);
    cleanups.push(() => first(), () => second());
    expect(() => assertResourceCredit({} as ResourceCredit, 3)).toThrow(/credit/);
    const forged = (() => undefined) as ResourceLease;
    expect(() => resourceLeaseCredit(forged)).toThrow(/binding/);
    const wrapper = (() => first()) as ResourceLease;
    bindResourceLeaseCredit(wrapper, first);
    expect(() => bindResourceLeaseCredit(wrapper, second)).toThrow(/another credit/);
    item.records[1]!.actual();
    expect(() => bindResourceLeaseCredit((() => undefined) as ResourceLease, second)).toThrow(/retired/);
  });
  it('keeps genuine ResourceLedger admissions source-compatible without wrappers', () => {
    const item = fixture(), owner = item.prepare({ admit: bytes => item.ledger.reserve('source', bytes) });
    expect(textOf(owner)).toBe(DECODER_V2); expect(collect(owner, false)).toEqual(encode(V2));
  });
  it('refuses and releases an unbound callable admission before any decoder descriptor materializes', () => {
    const item = fixture(), before = item.ledger.usage.bytes; let releases = 0, descriptors = 0;
    const freeze = Object.freeze;
    vi.spyOn(Object, 'freeze').mockImplementation(((value: object) => {
      if (Object.hasOwn(value, 'decoderName')) descriptors++;
      return freeze(value);
    }) as typeof Object.freeze);
    expect(() => item.prepare({ admit(bytes) {
      const lease = item.admit(bytes), unbound = (() => { releases++; lease(); }) as ResourceLease;
      Object.defineProperty(unbound, 'bytes', { get: () => lease.bytes }); unbound.resize = next => lease.resize(next);
      return unbound;
    } })).toThrow(/binding/);
    expect(releases).toBe(1); expect(descriptors).toBe(0); expect(item.ledger.usage.bytes).toBe(before);
  });
  it.each(['parser', 'catalog'] as const)('refuses unbound %s admissions and cleans the callable reservation', kind => {
    const item = account(); let releases = 0;
    const options = { current() {}, admit(bytes: number) {
      const lease = item.admit(bytes), unbound = (() => { releases++; lease(); }) as ResourceLease;
      Object.defineProperty(unbound, 'bytes', { get: () => lease.bytes }); unbound.resize = next => lease.resize(next);
      return unbound;
    } };
    expect(() => kind === 'parser' ? parseSogMetadata(encode(V2), options) :
      prepareSogCatalog([{ resourceId: 'm', acquisitionPath: 'meta.json', byteLength: 1 }], options)).toThrow(/binding/);
    expect(releases).toBe(1); expect(item.ledger.usage.bytes).toBe(0);
  });
  it('refuses two explicitly bound aliases of one owned credit without stealing it', () => {
    const item = fixture(), before = item.ledger.usage.bytes; let first: ResourceLease | undefined, aliasReleases = 0;
    expect(() => item.prepare({ admit(bytes) {
      if (!first) { first = item.admit(bytes); return first; }
      const alias = (() => { aliasReleases++; first!(); }) as ResourceLease;
      Object.defineProperty(alias, 'bytes', { get: () => first!.bytes }); alias.resize = next => first!.resize(next);
      return bindResourceLeaseCredit(alias, first);
    } })).toThrow(/reused.*credit/);
    expect(aliasReleases).toBe(0); expect(item.ledger.usage.bytes).toBe(before);
  });
});

describe('coherent ownership barriers after arbitrary hooks and getters', () => {
  it('refuses the final catalog getter retiring newly admitted graph credit before graph declarations allocate', () => {
    const item = fixture(), before = item.ledger.usage.bytes, first = item.records.length;
    const catalogBytes = item.catalog.stats.catalogBytes;
    const catalog = item.records.find(record => record.actual.bytes === catalogBytes)!;
    let reads = 0, dropped = false, lateDeclarations = 0, lateMaps = 0;
    Object.defineProperty(catalog.lease, 'bytes', { get() {
      if (item.records.length > first && !dropped && ++reads === 2) {
        // borrowedCurrent checked graph-own credit between these two catalog
        // reads. The last parent getter must not return into declaration work.
        dropped = true; item.records[first]!.actual();
      }
      return catalog.actual.bytes;
    } });
    const NativeMap = Map;
    class ObservedMap<K, V> extends NativeMap<K, V> {
      constructor(entries?: Iterable<readonly [K, V]> | null) { super(entries); if (dropped) lateMaps++; }
    }
    vi.stubGlobal('Map', ObservedMap);
    const freeze = Object.freeze;
    vi.spyOn(Object, 'freeze').mockImplementation(((value: object) => {
      if (dropped && Object.hasOwn(value, 'group') && Object.hasOwn(value, 'reference')) lateDeclarations++;
      return freeze(value);
    }) as typeof Object.freeze);
    expect(() => item.prepare()).toThrow(/credit|stale/);
    expect(reads).toBe(2); expect(dropped).toBe(true);
    expect(lateDeclarations).toBe(0); expect(lateMaps).toBe(0); expect(item.ledger.usage.bytes).toBe(before);
  });

  it.each(['text', 'JSON'] as const)('refuses a later parser getter retiring earlier credit before %s materialization', phase => {
    const item = account(), first = item.records.length; let count = 0, dropped = false, lateWork = 0;
    const decode = TextDecoder.prototype.decode, parse = JSON.parse;
    vi.spyOn(TextDecoder.prototype, 'decode').mockImplementation(function (this: TextDecoder, ...args) {
      if (dropped) lateWork++; return Reflect.apply(decode, this, args);
    });
    vi.spyOn(JSON, 'parse').mockImplementation((...args) => {
      if (dropped) lateWork++; return Reflect.apply(parse, JSON, args);
    });
    expect(() => parseSogMetadata(encode(V2), { current() {}, admit(bytes) {
      const lease = item.admit(bytes);
      if (++count === (phase === 'text' ? 2 : 3)) {
        const subject = item.records.at(-1)!; let reads = 0;
        Object.defineProperty(lease, 'bytes', { get() {
          // Read1 validates admission; read2 is the first current audit; read3
          // is the last getter of the final audit immediately before allocation.
          if (++reads === 3) { dropped = true; item.records[first]!.actual(); }
          return subject.actual.bytes;
        } });
      }
      return lease;
    } })).toThrow(/credit/);
    expect(dropped).toBe(true); expect(lateWork).toBe(0); expect(item.ledger.usage.bytes).toBe(0);
  });

  it('refuses a copy getter retiring parser credit before the independent M-byte copy allocates', () => {
    const item = fixture(), before = item.ledger.usage.bytes; let dropped = false, lateCopies = 0;
    const nativeSet = Uint8Array.prototype.set;
    vi.spyOn(Uint8Array.prototype, 'set').mockImplementation(function (this: Uint8Array, source: ArrayLike<number>, offset?: number) {
      if (dropped) lateCopies++; return nativeSet.call(this, source, offset);
    });
    expect(() => item.metadata.copyOriginal({ current() {}, admit(bytes) {
      const lease = item.admit(bytes), record = item.records.at(-1)!; let reads = 0;
      Object.defineProperty(lease, 'bytes', { get() {
        if (++reads === 2) { dropped = true; item.records[0]!.actual(); }
        return record.actual.bytes;
      } });
      return lease;
    } })).toThrow(/credit/);
    expect(dropped).toBe(true); expect(lateCopies).toBe(0);
    expect(item.ledger.usage.bytes).toBe(before - 2 * encode(V2).length);
  });

  it('refuses an independent copy whose lying bytes getter retires its actual reservation', () => {
    const item = fixture(); let armed = false, lease: ResourceLease | undefined;
    const copy = item.metadata.copyOriginal({ current() {}, admit(bytes) {
      lease = item.admit(bytes); const record = item.records.at(-1)!;
      Object.defineProperty(lease, 'bytes', { get() { if (armed) record.actual(); return bytes; } });
      return lease;
    } });
    cleanups.push(() => copy.dispose()); armed = true;
    expect(() => copy.bytes).toThrow(/credit/);
    expect(resourceCreditBytes(resourceLeaseCredit(lease!))).toBeUndefined();
  });

  it('refuses a selected descriptor getter retiring catalog credit before snapshotting it', () => {
    const item = account(); let dropped = false, lateSnapshots = 0;
    const freeze = Object.freeze;
    vi.spyOn(Object, 'freeze').mockImplementation(((value: object) => {
      if (dropped && Object.hasOwn(value, 'acquisitionPath')) lateSnapshots++;
      return freeze(value);
    }) as typeof Object.freeze);
    expect(() => prepareSogCatalog([{ get resourceId() { dropped = true; item.records[0]!.actual(); return 'metadata'; },
      acquisitionPath: BASE + 'meta.json', byteLength: 1 }], { admit: item.admit, current() {} })).toThrow(/credit|stale/);
    expect(dropped).toBe(true); expect(lateSnapshots).toBe(0); expect(item.ledger.usage.bytes).toBe(0);
  });

  it('refuses a graph-current hook dropping preparation credit before names or decoder descriptors allocate', () => {
    const item = fixture(), before = item.ledger.usage.bytes, first = item.records.length;
    let calls = 0, preparation: LeaseRecord | undefined, armed = false, dropped = false, lateMaps = 0, descriptors = 0;
    const NativeMap = Map;
    class ObservedMap<K, V> extends NativeMap<K, V> {
      constructor(entries?: Iterable<readonly [K, V]> | null) { super(entries); if (dropped) lateMaps++; }
    }
    vi.stubGlobal('Map', ObservedMap);
    const freeze = Object.freeze;
    vi.spyOn(Object, 'freeze').mockImplementation(((value: object) => {
      if (Object.hasOwn(value, 'decoderName')) descriptors++;
      return freeze(value);
    }) as typeof Object.freeze);
    expect(() => item.prepare({
      admit(bytes) {
        const lease = item.admit(bytes);
        if (++calls === 2) {
          preparation = item.records.at(-1)!;
          Object.defineProperty(lease, 'bytes', { get() {
            // Arm only after the independent original M-byte copy exists. This
            // is the owner's last raw getter before parents() calls graph.current.
            if (item.records.length === first + 3 && !dropped) armed = true;
            return preparation!.actual.bytes;
          } });
        }
        return lease;
      },
      current() {
        if (armed && !dropped) { dropped = true; preparation!.actual(); }
      },
    })).toThrow(/credit/);
    expect(dropped).toBe(true); expect(calls).toBe(3);
    expect(descriptors).toBe(0); expect(lateMaps).toBe(0); expect(item.ledger.usage.bytes).toBe(before);
  });

  it.each(['prep-to-copy', 'copy-to-prep', 'work-to-copy', 'work-to-prep'] as const)(
    'refuses %s invalidation from a later getter before first output copy or consumer', mode => {
      const item = fixture(), first = item.records.length;
      let armed = false, dropped = false, lateCopies = 0, calls = 0;
      const owner = item.prepare({ admit(bytes) {
        const lease = item.admit(bytes), index = item.records.length - first - 1;
        const subject = mode.startsWith('prep') ? 1 : mode.startsWith('copy') ? 2 : 3;
        if (index === subject) {
          const record = item.records.at(-1)!; let reads = 0;
          Object.defineProperty(lease, 'bytes', { get() {
            reads++;
            // A work lease's first getter is its admission validation. Exercise
            // the later owner audit after the retained credits were read.
            if (armed && (subject !== 3 || reads > 1)) {
              armed = false; dropped = true;
              item.records[first + (mode.endsWith('copy') ? 2 : 1)]!.actual();
            }
            return record.actual.bytes;
          } });
        }
        return lease;
      } });
      armed = true;
      const nativeSet = Uint8Array.prototype.set;
      vi.spyOn(Uint8Array.prototype, 'set').mockImplementation(function (this: Uint8Array, input: ArrayLike<number>, offset?: number) {
        if (dropped) lateCopies++; return nativeSet.call(this, input, offset);
      });
      expect(() => owner.writeDecoder(() => { calls++; }, 7)).toThrow(/credit/);
      expect(dropped).toBe(true); expect(lateCopies).toBe(0); expect(calls).toBe(0);
    });

  it.each(['prep-to-copy', 'copy-to-prep', 'work-to-copy', 'work-to-prep'] as const)(
    'refuses %s invalidation after one consumer before any next copy or consumer', mode => {
      const item = fixture(); let armed = false, dropped = false, lateCopies = 0, consumers = 0;
      const first = item.records.length;
      const owner = item.prepare({ admit(bytes) {
        const lease = item.admit(bytes), index = item.records.length - first - 1;
        const subject = mode.startsWith('prep') ? 1 : mode.startsWith('copy') ? 2 : 3;
        if (index === subject) {
          const record = item.records.at(-1)!;
          Object.defineProperty(lease, 'bytes', { get() {
            if (armed) {
              armed = false; dropped = true;
              item.records[first + (mode.endsWith('copy') ? 2 : 1)]!.actual();
            }
            return record.actual.bytes;
          } });
        }
        return lease;
      } });
      const nativeSet = Uint8Array.prototype.set;
      vi.spyOn(Uint8Array.prototype, 'set').mockImplementation(function (this: Uint8Array, input: ArrayLike<number>, offset?: number) {
        if (dropped) lateCopies++; return nativeSet.call(this, input, offset);
      });
      expect(() => owner.writeDecoder(() => { consumers++; armed = true; }, 7)).toThrow(/credit/);
      expect(dropped).toBe(true); expect(consumers).toBe(1); expect(lateCopies).toBe(0);
    });
});

describe('authenticated SOG resource-to-decoder binding', () => {
  it('pins a complete independently expected resource/name table and literal decoder bytes', () => {
    const item = fixture(), owner = item.prepare();
    expect(owner.resources).toEqual([
      { resourceId: 'color.webp', acquisitionPath: BASE + 'color.webp', byteLength: 15, role: 'referenced', fingerprintPath: 'color.webp', decoderName: 'r0000.webp' },
      { resourceId: 'high.webp', acquisitionPath: BASE + 'high.webp', byteLength: 12, role: 'referenced', fingerprintPath: 'high.webp', decoderName: 'r0001.webp' },
      { resourceId: 'low.webp', acquisitionPath: BASE + 'low.webp', byteLength: 11, role: 'referenced', fingerprintPath: 'low.webp', decoderName: 'r0002.webp' },
      { resourceId: 'metadata', acquisitionPath: BASE + 'meta.json', byteLength: encode(V2).length, role: 'primary', fingerprintPath: 'meta.json', decoderName: 'meta.json' },
      { resourceId: 'rotation.webp', acquisitionPath: BASE + 'rotation.webp', byteLength: 14, role: 'referenced', fingerprintPath: 'rotation.webp', decoderName: 'r0003.webp' },
      { resourceId: 'scale.webp', acquisitionPath: BASE + 'scale.webp', byteLength: 13, role: 'referenced', fingerprintPath: 'scale.webp', decoderName: 'r0004.webp' },
    ]);
    expect(owner.bindings.map(entry => [entry.group, entry.index, entry.reference, entry.decoderName])).toEqual([
      ['means', 0, 'low.webp', 'r0002.webp'], ['means', 1, 'high.webp', 'r0001.webp'],
      ['scales', 0, 'scale.webp', 'r0004.webp'], ['quats', 0, 'rotation.webp', 'r0003.webp'], ['sh0', 0, 'color.webp', 'r0000.webp'],
    ]);
    expect(owner.originalByteLength).toBe(encode(V2).length); expect(owner.byteLength).toBe(encode(DECODER_V2).length);
    expect(owner.primaryResourceId).toBe('metadata'); expect(owner.totalBytes).toBe(encode(V2).length + 65);
    expect(textOf(owner)).toBe(DECODER_V2); expect(collect(owner, false)).toEqual(encode(V2));
    expect(owner.version).toBe(2); expect(owner.sourceCount).toBe(3); expect(owner.shDegree).toBe(0);
    expect(Object.isFrozen(owner)).toBe(true); expect(Object.isFrozen(owner.resources)).toBe(true);
    expect(Object.isFrozen(owner.bindings)).toBe(true);
    expect(owner.resources.every(Object.isFrozen)).toBe(true); expect(owner.bindings.every(Object.isFrozen)).toBe(true);
  });
  it('includes aliases and all undeccoded extras, preserves declaration array order', () => {
    const text = V2.replace('["low.webp","high.webp"]', '["./low.webp","high.webp","sub/../low.webp","extra.bin"]')
      .replace('["scale.webp"]', '["scale.webp","extra.bin"]');
    const item = fixture(text, [{ resourceId: 'extra', acquisitionPath: BASE + 'extra.bin', byteLength: 99 }]);
    const owner = item.prepare(), value = JSON.parse(textOf(owner));
    expect(owner.resources.length).toBe(7); expect(owner.totalBytes).toBe(encode(text).length + 65 + 99);
    expect(value.means.files).toEqual(['r0003.webp', 'r0002.webp', 'r0003.webp', 'r0001.webp']);
    expect(value.scales.files).toEqual(['r0005.webp', 'r0001.webp']);
    expect(owner.bindings.filter(entry => entry.resourceId === 'low.webp').length).toBe(2);
    expect(owner.bindings.filter(entry => entry.resourceId === 'extra').length).toBe(2);
    expect(collect(owner, false)).toEqual(encode(text));
  });
  it('never includes or reads unrelated selected neighbors', () => {
    const owner = fixture(V2, [{ resourceId: 'neighbor', acquisitionPath: BASE + 'neighbor.webp', byteLength: 0xffff_ffff }]).prepare();
    expect(owner.resources.length).toBe(6); expect(owner.resources.some(entry => entry.resourceId === 'neighbor')).toBe(false);
    expect(textOf(owner)).toBe(DECODER_V2);
  });
  it('copies parser-private originals rather than a later mutated acquisition buffer', () => {
    const item = fixture(); item.bytes.fill(0); const owner = item.prepare();
    expect(collect(owner, false)).toEqual(encode(V2)); expect(textOf(owner)).toBe(DECODER_V2);
  });
  it('preserves original bytes/digest, paths and descriptors across mutated/transferred output segments', () => {
    const owner = fixture().prepare(), originalDigest = digest(encode(V2)), before = owner.resources;
    owner.writeDecoder(bytes => { bytes.fill(0); }, 7);
    owner.writeOriginal(bytes => { structuredClone(bytes.buffer, { transfer: [bytes.buffer] }); }, 3);
    expect(digest(collect(owner, false))).toBe(originalDigest); expect(textOf(owner)).toBe(DECODER_V2);
    expect(owner.resources).toBe(before); expect(owner.resources.map(entry => entry.fingerprintPath)).toEqual([
      'color.webp', 'high.webp', 'low.webp', 'meta.json', 'rotation.webp', 'scale.webp']);
  });
  it.each(['metadata', 'catalog'] as const)('refuses a forged %s rather than accepting shape-compatible declarations', kind => {
    const item = fixture(), before = item.ledger.usage.bytes;
    const metadata = kind === 'metadata' ? { ...item.metadata, assertCurrent() {} } as PreparedSogMetadata : item.metadata;
    const catalog = kind === 'catalog' ? { ...item.catalog, assertCurrent() {} } as PreparedSogCatalog : item.catalog;
    expect(() => prepareSogDecoderMetadata(metadata, BASE + 'meta.json', catalog, { admit: item.admit, current() {} })).toThrow(/issued|catalog/i);
    expect(item.ledger.usage.bytes).toBe(before);
  });
  it('refuses missing extras before publishing any owner or output', () => {
    const item = fixture(V2.replace('["low.webp","high.webp"]', '["low.webp","high.webp","missing"]'));
    const before = item.ledger.usage.bytes;
    expect(() => item.prepare()).toThrow(/not acquired/); expect(item.ledger.usage.bytes).toBe(before);
  });
});

describe('byte-preserving lexical serialization and native numeric semantics', () => {
  it.each([1, 2, 3, 7, 63, 65_536, MAX_SOG_DECODER_SEGMENT_BYTES])('emits exact UTF-8 through segments of at most %i bytes', capacity => {
    const suffix = ',"unknown":{"emoji":"🦉é\\uD83D\\uDE80","escaped":"a\\n\\t\\/\\\\\\\"z","files":["low.webp"]}';
    const text = '\ufeff \r\n' + V2.slice(0, -1) + suffix + '} \t';
    const owner = fixture(text).prepare(), chunks: number[] = [];
    owner.writeDecoder(bytes => { chunks.push(bytes.length); }, capacity);
    expect(chunks.every(length => length >= 1 && length <= capacity)).toBe(true);
    expect(chunks.reduce((sum, length) => sum + length, 0)).toBe(owner.byteLength);
    // TextDecoder strips the BOM; compare bytes to retain it in the oracle.
    expect(collect(owner, true, capacity)).toEqual(encode('\ufeff \r\n' + DECODER_V2.slice(0, -1) + suffix + '} \t'));
    expect(collect(owner, false, capacity)).toEqual(encode(text));
  });
  it('does not parse/stringify a second JSON graph or materialize an output string', () => {
    const item = fixture();
    const parse = vi.spyOn(JSON, 'parse').mockImplementation(() => { throw new Error('second DOM forbidden'); });
    const stringify = vi.spyOn(JSON, 'stringify').mockImplementation(() => { throw new Error('whole serialization forbidden'); });
    const owner = item.prepare(); expect(textOf(owner, 3)).toBe(DECODER_V2);
    expect(parse).not.toHaveBeenCalled(); expect(stringify).not.toHaveBeenCalled();
  });
  it('rewrites escaped known keys and escaped reference characters', () => {
    const text = V2.replace('"means"', '"m\\u0065ans"').replaceAll('"files"', '"fi\\u006ces"')
      .replace('"low.webp"', '"lo\\u0077.webp"');
    const owner = fixture(text).prepare();
    expect(textOf(owner)).toBe(DECODER_V2.replace('"means"', '"m\\u0065ans"').replaceAll('"files"', '"fi\\u006ces"'));
  });
  it('retains overwritten groups/files unchanged and rewrites only final declared entries', () => {
    const prefix = '{"means":null,"scales":{"files":[{"x":[1,2,3]},"not-acquired"]},';
    const text = prefix + V2.slice(1).replace('"files":["low.webp","high.webp"]',
      '"files":["old-not-acquired"],"fi\\u006ces":["low.webp","high.webp"]');
    const owner = fixture(text).prepare();
    expect(textOf(owner)).toBe(prefix + DECODER_V2.slice(1).replace('"files":["r0002.webp","r0001.webp"]',
      '"files":["old-not-acquired"],"fi\\u006ces":["r0002.webp","r0001.webp"]'));
    expect(owner.bindings.length).toBe(5);
  });
  it('does not retain an unbounded overwritten files array', () => {
    const ignored = Array.from({ length: 2000 }, () => '"not-acquired"').join(',');
    const text = V2.replace('"files":["low.webp","high.webp"]', `"files":[${ignored}],"files":["low.webp","high.webp"]`);
    const owner = fixture(text).prepare();
    expect(owner.bindings.length).toBe(5); expect(textOf(owner)).toBe(DECODER_V2.replace('"files":["r0002.webp","r0001.webp"]',
      `"files":[${ignored}],"files":["r0002.webp","r0001.webp"]`));
  });
  it.each(['true', '1.9', '1'])('preserves native v1 version conversion %s without normalizing the bytes', version => {
    const text = `{"version":${version},` + V1.slice(1), owner = fixture(text).prepare();
    expect(owner.version).toBe(1); expect(owner.shDegree).toBe(0);
    expect(textOf(owner)).toContain(`"version":${version}`); expect(collect(owner, false)).toEqual(encode(text));
  });
  it.each(['2', '2.9'])('preserves native v2 conversion %s, fractional integer fields and signed-zero lexemes', version => {
    const text = V2.replace('"version":2', `"version":${version}`).replace('"count":3', '"count":3.9')
      .replace('"mins":[0,0,0]', '"mins":[-0,-0.0,-0e0]').replace('"codebook":[0]', '"codebook":[1e300,true,-0]');
    const owner = fixture(text).prepare(); expect(owner.version).toBe(2); expect(owner.sourceCount).toBe(3);
    const rewritten = textOf(owner);
    expect(rewritten).toContain('"count":3.9'); expect(rewritten).toContain('"mins":[-0,-0.0,-0e0]');
    expect(rewritten).toContain('"codebook":[1e300,true,-0]');
    expect(Object.is(JSON.parse(rewritten).means.mins[0], -0)).toBe(true);
  });
  it.each(['"shN":null', '"shN":{"files":["ignored"]},"shN":null'])('preserves SH0 null and overwritten SH declarations: %s', field => {
    const text = V2.slice(0, -1) + ',' + field + '}', owner = fixture(text).prepare();
    expect(owner.shDegree).toBe(0); expect(owner.bindings.length).toBe(5);
    expect(textOf(owner)).toBe(DECODER_V2.slice(0, -1) + ',' + field + '}');
  });
  it.each([1, 2, 3])('case %#: rewrites both v2 SH% i resources and every extra', bands => {
    const sh = `,"shN":{"bands":${bands},"count":64,"codebook":[0],"files":["centroids.webp","labels.webp","extra.bin"]}`;
    const owner = fixture(V2.slice(0, -1) + sh + '}', [
      { resourceId: 'centroids', acquisitionPath: BASE + 'centroids.webp', byteLength: 16 },
      { resourceId: 'labels', acquisitionPath: BASE + 'labels.webp', byteLength: 17 },
      { resourceId: 'extra', acquisitionPath: BASE + 'extra.bin', byteLength: 18 },
    ]).prepare();
    expect(owner.shDegree).toBe(bands);
    expect(JSON.parse(textOf(owner)).shN.files).toEqual(['r0000.webp', 'r0004.webp', 'r0002.webp']);
  });
  it('keeps legacy SH degree unknown until texture decode while rewriting its original references', () => {
    const owner = fixture(V1.slice(0, -1) + ',"shN":{"mins":-1,"maxs":1,"files":["centroids.webp","labels.webp"]}}', [
      { resourceId: 'centroids', acquisitionPath: BASE + 'centroids.webp', byteLength: 16 },
      { resourceId: 'labels', acquisitionPath: BASE + 'labels.webp', byteLength: 17 },
    ]).prepare();
    expect(owner.shDegree).toBe(null); expect(owner.version).toBe(1);
    expect(JSON.parse(textOf(owner)).shN.files).toEqual(['r0000.webp', 'r0003.webp']);
  });
  it('keeps exact Unicode/case resources distinct while safe decoder names stay ASCII', () => {
    const text = V2.replace('"low.webp","high.webp"', '"é.webp","e\\u0301.webp","É.webp","🦉.webp"');
    const owner = fixture(text, [
      { resourceId: 'composed', acquisitionPath: BASE + 'é.webp', byteLength: 1 },
      { resourceId: 'decomposed', acquisitionPath: BASE + 'é.webp', byteLength: 2 },
      { resourceId: 'uppercase', acquisitionPath: BASE + 'É.webp', byteLength: 3 },
      { resourceId: 'owl', acquisitionPath: BASE + '🦉.webp', byteLength: 4 },
    ]).prepare();
    expect(owner.resources.map(entry => entry.fingerprintPath)).toEqual([
      'color.webp', 'é.webp', 'meta.json', 'rotation.webp', 'scale.webp', 'É.webp', 'é.webp', '🦉.webp']);
    expect(JSON.parse(textOf(owner)).means.files).toEqual(['r0005.webp', 'r0001.webp', 'r0004.webp', 'r0006.webp']);
    expect(owner.resources.every(entry => /^[a-z0-9.]+$/.test(entry.decoderName) && !entry.decoderName.includes('..'))).toBe(true);
  });
});

describe('exact admission, independence and retirement', () => {
  it('retains exactly M + its descriptor/spans allowance after temporary graph retirement', () => {
    const item = fixture(), before = item.ledger.usage.bytes, owner = item.prepare();
    expect(item.ledger.usage.bytes - before).toBe(encode(V2).length + owner.preparationBytes);
    const retained = item.ledger.usage.bytes, capacity = 7;
    owner.writeDecoder(() => { expect(item.ledger.usage.bytes).toBe(retained + 2 * capacity); }, capacity);
    expect(item.ledger.usage.bytes).toBe(retained);
    owner.dispose(); owner.dispose(); expect(item.ledger.usage.bytes).toBe(before);
  });
  it('owns its original copy and every descriptor independently after both parents retire', () => {
    const item = fixture(), owner = item.prepare(), retained = owner.preparationBytes + owner.originalByteLength;
    item.metadata.dispose(); item.catalog.dispose();
    expect(item.ledger.usage.bytes).toBe(retained); expect(textOf(owner)).toBe(DECODER_V2);
    expect(collect(owner, false)).toEqual(encode(V2)); expect(owner.resources.length).toBe(6);
    owner.dispose(); expect(item.ledger.usage.bytes).toBe(0);
  });
  it.each(['metadata', 'catalog'] as const)('refuses %s retirement during construction and restores retained accounting', parent => {
    const item = fixture(); let calls = 0;
    expect(() => item.prepare({ current() { if (++calls === 8) item[parent].dispose(); } })).toThrow(/disposed/);
    // Remaining parent still owns its unchanged reservations.
    item.metadata.dispose(); item.catalog.dispose(); expect(item.ledger.usage.bytes).toBe(0);
  });
  it.each([1, 2, 3])('unwinds exact owners after admission refusal #%i', refused => {
    const item = fixture(), before = item.ledger.usage.bytes; let calls = 0;
    expect(() => item.prepare({ admit(bytes) { if (++calls === refused) throw new Error('refused exact owner'); return item.admit(bytes); } })).toThrow(/refused/);
    expect(item.ledger.usage.bytes).toBe(before);
  });
  it('refuses per-emission allocation before emitting any bytes and leaves the owner usable', () => {
    const item = fixture(); let refuse = false;
    const owner = item.prepare({ admit(bytes) { if (refuse) throw new Error('chunk refused'); return item.admit(bytes); } });
    const before = item.ledger.usage.bytes, consume = vi.fn(); refuse = true;
    expect(() => owner.writeDecoder(consume, 7)).toThrow(/chunk refused/); expect(consume).not.toHaveBeenCalled();
    expect(item.ledger.usage.bytes).toBe(before); refuse = false; expect(textOf(owner)).toBe(DECODER_V2);
  });
  it.each([1, 2, 3])('releases a callable thenable admission exactly once at owner #%i', refused => {
    const item = fixture(), before = item.ledger.usage.bytes; let calls = 0;
    expect(() => item.prepare({ admit(bytes) {
      const lease = item.admit(bytes);
      if (++calls === refused) Object.defineProperty(lease, 'then', { value: (_yes: unknown, no: (error: unknown) => void) => no(new Error('async lease')) });
      return lease;
    } })).toThrow(/synchronous/);
    expect(item.ledger.usage.bytes).toBe(before);
  });
  it.each([1, 2, 3])('cleans malformed callable credit at owner #%i', refused => {
    const item = fixture(), before = item.ledger.usage.bytes; let calls = 0;
    expect(() => item.prepare({ admit(bytes) {
      const lease = item.admit(bytes); if (++calls === refused) item.records.at(-1)!.actual.resize(bytes - 1); return lease;
    } })).toThrow(/credit|lease/);
    expect(item.ledger.usage.bytes).toBe(before);
  });
  it('does not steal/release an already-owned lease if admission tries to reuse it', () => {
    const item = fixture(), before = item.ledger.usage.bytes; let first: ResourceLease | undefined;
    expect(() => item.prepare({ admit(bytes) { if (first) return first; first = item.admit(bytes); return first; } })).toThrow(/reused/);
    expect(item.ledger.usage.bytes).toBe(before);
  });
  it('refuses async current and observes its rejection without leaking preparation', async () => {
    const item = fixture(), before = item.ledger.usage.bytes;
    expect(() => item.prepare({ current: (() => Promise.reject(new Error('async current'))) as unknown as () => void })).toThrow(/synchronous/);
    await Promise.resolve(); expect(item.ledger.usage.bytes).toBe(before);
  });
  it('preserves ownership hook receivers and snapshots methods once', () => {
    const item = fixture(), receiver = { tag: 'subject', admit(bytes: number) { expect(this.tag).toBe('subject'); return item.admit(bytes); },
      current() { expect(this.tag).toBe('subject'); } };
    const owner = item.prepare(receiver);
    receiver.admit = () => { throw new Error('late admit mutation'); }; receiver.current = () => { throw new Error('late current mutation'); };
    expect(textOf(owner)).toBe(DECODER_V2);
  });
  it.each(['release', 'shrink', 'grow'] as const)('detects external retained credit %s before publication', action => {
    const item = fixture(), first = item.records.length, owner = item.prepare();
    const retained = item.records.slice(first).find(record => record.actual.bytes === owner.preparationBytes)!;
    if (action === 'release') retained.actual();
    else retained.actual.resize(retained.amount + (action === 'shrink' ? -1 : 1));
    const consume = vi.fn(); expect(() => owner.writeDecoder(consume)).toThrow(/credit/); expect(consume).not.toHaveBeenCalled();
  });
  it('detects external original-copy credit loss independently of retained descriptor credit', () => {
    const item = fixture(), first = item.records.length, owner = item.prepare();
    const copy = item.records.slice(first).find(record => record.amount === encode(V2).length)!; copy.actual();
    expect(() => owner.resources).toThrow(/credit/); expect(() => owner.writeOriginal(() => undefined)).toThrow(/credit/);
  });
  it('revokes immediately but retains all owners until a disposing consumer unwinds', () => {
    const item = fixture(), before = item.ledger.usage.bytes, owner = item.prepare(), retained = item.ledger.usage.bytes;
    let segments = 0;
    expect(() => owner.writeDecoder(() => {
      segments++; owner.dispose(); owner.dispose();
      expect(item.ledger.usage.bytes).toBe(retained + 14);
      expect(() => owner.resources).toThrow(/disposed/);
    }, 7)).toThrow(/disposed/);
    expect(segments).toBe(1); expect(item.ledger.usage.bytes).toBe(before);
  });
  it('rejects consumer reentrancy without advancing or releasing outer credit', () => {
    const item = fixture(), owner = item.prepare(), retained = item.ledger.usage.bytes;
    owner.writeDecoder(() => {
      expect(() => owner.writeOriginal(() => undefined, 1)).toThrow(/reentrant/);
      expect(item.ledger.usage.bytes).toBe(retained + 14);
    }, 7);
    expect(textOf(owner)).toBe(DECODER_V2); expect(item.ledger.usage.bytes).toBe(retained);
  });
  it('also rejects reentrant emission from the current hook before first output', () => {
    const item = fixture(); let owner: PreparedSogDecoderMetadata | undefined, nested = false;
    owner = item.prepare({ current() {
      if (owner && !nested) { nested = true; expect(() => owner!.writeOriginal(() => undefined, 1)).toThrow(/reentrant/); }
    } });
    expect(textOf(owner!)).toBe(DECODER_V2); expect(nested).toBe(true);
  });
  it.each(['throw', 'promise', 'thenable'] as const)('stops at the first failed %s consumer and retains a reusable owner', async mode => {
    const item = fixture(), owner = item.prepare(), before = item.ledger.usage.bytes; let calls = 0;
    expect(() => owner.writeDecoder(() => {
      calls++;
      if (mode === 'throw') throw new Error('consumer refusal');
      if (mode === 'promise') return Promise.reject(new Error('consumer refusal'));
      return { then(_yes: unknown, no: (error: unknown) => void) { no(new Error('consumer refusal')); } };
    }, 7)).toThrow(/consumer refusal|synchronous/);
    await Promise.resolve(); expect(calls).toBe(1); expect(item.ledger.usage.bytes).toBe(before);
    expect(textOf(owner)).toBe(DECODER_V2);
  });
  it('continues all cleanup and preserves throw-undefined and async cleanup failures', async () => {
    const item = fixture(); let calls = 0;
    const owner = item.prepare({ admit(bytes) {
      const lease = item.admit(bytes), which = ++calls;
      if (which === 2 || which === 3) {
        const bad = (() => { lease(); if (which === 2) throw undefined; return Promise.reject(new Error('async release')); }) as unknown as ResourceLease;
        Object.defineProperty(bad, 'bytes', { get: () => lease.bytes }); bad.resize = next => lease.resize(next);
        return bindResourceLeaseCredit(bad, lease);
      }
      return lease;
    } });
    expect(() => owner.dispose()).toThrow(AggregateError); await Promise.resolve();
    owner.dispose(); item.metadata.dispose(); item.catalog.dispose(); expect(item.ledger.usage.bytes).toBe(0);
  });
  it.each(['originalByteLength', 'byteLength', 'version', 'sourceCount', 'shDegree', 'primaryResourceId', 'totalBytes', 'resources', 'bindings', 'preparationBytes'] as const)(
    'refuses %s access after idempotent retirement', key => {
      const owner = fixture().prepare(); owner.dispose(); owner.dispose(); expect(() => owner[key]).toThrow(/disposed/);
    });
});

describe('explicit output and segment ceilings', () => {
  it('accepts an exact tightened output limit and refuses limit minus one with no partial owner', () => {
    const item = fixture(), expected = encode(DECODER_V2).length, before = item.ledger.usage.bytes;
    const owner = item.prepare({ maxDecoderBytes: expected }); expect(textOf(owner)).toBe(DECODER_V2); owner.dispose();
    expect(item.ledger.usage.bytes).toBe(before);
    expect(() => item.prepare({ maxDecoderBytes: expected - 1 })).toThrow(/byte limit/);
    expect(item.ledger.usage.bytes).toBe(before);
  });
  it.each([0, -1, 1.5, NaN, Infinity, MAX_SOG_DECODER_METADATA_BYTES + 1, '100', null])('refuses invalid output limit %s', maxDecoderBytes => {
    const item = fixture(), before = item.ledger.usage.bytes;
    expect(() => item.prepare({ maxDecoderBytes: maxDecoderBytes as number })).toThrow(/limit/);
    expect(item.ledger.usage.bytes).toBe(before);
  });
  it.each([0, -1, 1.5, NaN, Infinity, MAX_SOG_DECODER_SEGMENT_BYTES + 1, '1', null])('refuses invalid segment size %s before consumer/admission', capacity => {
    const item = fixture(), owner = item.prepare(), before = item.ledger.usage.bytes, count = item.records.length, consume = vi.fn();
    expect(() => owner.writeDecoder(consume, capacity as number)).toThrow(/segment/);
    expect(consume).not.toHaveBeenCalled(); expect(item.records.length).toBe(count); expect(item.ledger.usage.bytes).toBe(before);
  });
  it('refuses rewritten metadata expansion past the actual native 16MiB ceiling', () => {
    // Every 1-byte reference expands to a 10-byte opaque name: exactly45 bytes.
    const short = V2.replace('low.webp', 'a').replace('high.webp', 'b').replace('scale.webp', 's')
      .replace('rotation.webp', 'q').replace('color.webp', 'c');
    const original = short + ' '.repeat(MAX_SOG_DECODER_METADATA_BYTES - encode(short).length), item = fixture(original,
      ['a', 'b', 's', 'q', 'c'].map(name => ({ resourceId: name, acquisitionPath: BASE + name, byteLength: 1 })));
    const before = item.ledger.usage.bytes;
    expect(() => item.prepare()).toThrow(/decoder byte limit/); expect(item.ledger.usage.bytes).toBe(before);
  });
});
