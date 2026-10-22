import { afterEach, describe, expect, it, vi } from 'vitest';
import { bindResourceLeaseCredit, ResourceLedger, type ResourceLease } from '../src/document/resources';
import { assertPreparedSogMetadata, assertPreparedSogMetadataAlive, DEFAULT_SOG_METADATA_LIMITS, parseSogMetadata, type PreparedSogMetadata,
  type SogMetadataLimits, type SogMetadataOptions } from '../src/io/sogMetadata';

// Literal census is independent of the parser: 42 values/keys, 80 decoded
// string units and three container levels, including every required group.
const V2 = '{"version":2,"count":1,"means":{"files":["a","b"],"mins":[0,0,0],"maxs":[1,1,1]},"scales":{"files":["s"],"codebook":[0]},"quats":{"files":["q"]},"sh0":{"files":["c"],"codebook":[0]}}';
const encode = (text: string) => new TextEncoder().encode(text);
const extra = (value: string, key = 'x') => `${V2.slice(0, -1)},${JSON.stringify(key)}:${value}}`;
function v2(): Record<string, any> {
  return { version: 2, count: 3, means: { files: ['low.webp', 'high.webp'], mins: [-1, -2, -3], maxs: [1, 2, 3] },
    scales: { files: ['scale.webp'], codebook: [0, 1] }, quats: { files: ['rotation.webp'] },
    sh0: { files: ['color.webp'], codebook: [-1, 1] } };
}
function v1(): Record<string, any> {
  return { means: { files: ['low.webp', 'high.webp'], shape: [3, 3], mins: [-1, -2, -3], maxs: [1, 2, 3] },
    scales: { files: ['scale.webp'], mins: [-4, -5, -6], maxs: [1, 2, 3] },
    quats: { files: ['rotation.webp'] }, sh0: { files: ['color.webp'], mins: [-1, -2, -3, -4], maxs: [1, 2, 3, 4] } };
}

const cleanups: (() => void)[] = [];
const accounts: { ledger: ResourceLedger; duplicates: number[] }[] = [];
function account(current: () => void = () => undefined) {
  const ledger = new ResourceLedger(256 * 1024 * 1024), amounts: number[] = [], duplicates: number[] = [];
  const admit = vi.fn((bytes: number): ResourceLease => {
    amounts.push(bytes);
    const actual = ledger.reserve('source', bytes);
    let calls = 0;
    const lease = (() => { if (++calls > 1) duplicates.push(bytes); actual(); }) as ResourceLease;
    Object.defineProperty(lease, 'bytes', { get: () => actual.bytes });
    lease.resize = next => actual.resize(next);
    return bindResourceLeaseCredit(lease, actual);
  });
  const options = { admit, current };
  const parse = (input: string | Uint8Array, limits?: Partial<SogMetadataLimits>): PreparedSogMetadata => {
    const owner = parseSogMetadata(typeof input === 'string' ? encode(input) : input, { ...options, limits });
    cleanups.push(() => owner.dispose()); return owner;
  };
  const result = { ledger, amounts, duplicates, admit, options, parse };
  accounts.push(result); return result;
}
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  for (const item of accounts.splice(0)) {
    expect(item.duplicates).toEqual([]);
    expect(item.ledger.usage.bytes).toBe(0); expect(item.ledger.usage.allocations).toBe(0);
  }
  vi.restoreAllMocks();
});

describe('bounded SOG metadata ownership and census', () => {
  it('admits private-copy overlap, text/preflight and graph before materialization', () => {
    const item = account(), M = encode(V2).length;
    const nativeParse = JSON.parse;
    const materialize = vi.spyOn(JSON, 'parse').mockImplementation(text => {
      expect(item.amounts).toEqual([2 * M, 2 * M + 65_536, 42 * 256 + 80 * 2]);
      return nativeParse(text);
    });
    const metadata = item.parse(V2);
    expect(materialize).toHaveBeenCalledOnce();
    expect(metadata.stats).toEqual({ tokens: 42, stringUnits: 80, maxDepth: 3,
      parserBytes: 2 * M + 65_536 + 42 * 256 + 80 * 2 });
    expect(item.ledger.usage.bytes).toBe(2 * M + metadata.stats.parserBytes);
    expect(metadata.version).toBe(2); expect(metadata.sourceCount).toBe(1); expect(metadata.shDegree).toBe(0);
    expect(metadata.declarations).toEqual([
      { group: 'means', index: 0, reference: 'a' }, { group: 'means', index: 1, reference: 'b' },
      { group: 'scales', index: 0, reference: 's' }, { group: 'quats', index: 0, reference: 'q' },
      { group: 'sh0', index: 0, reference: 'c' },
    ]);
    expect(Object.isFrozen(metadata)).toBe(true); expect(Object.isFrozen(metadata.stats)).toBe(true);
    expect(Object.isFrozen(metadata.declarations)).toBe(true);
    expect(metadata.declarations.every(Object.isFrozen)).toBe(true);
    metadata.dispose(); metadata.dispose();
    for (const key of ['byteLength', 'version', 'sourceCount', 'shDegree', 'declarations', 'stats'] as const)
      expect(() => metadata[key]).toThrow(/disposed/);
    expect(() => metadata.assertCurrent()).toThrow(/disposed/);
  });
  it('keeps exact original bytes private and separately owns independent copies', () => {
    const item = account(), input = encode(` \n${V2}\t`), expected = input.slice();
    const owner = item.parse(input); input.fill(0);
    const first = owner.copyOriginal(item.options), second = owner.copyOriginal(item.options);
    cleanups.push(() => first.dispose(), () => second.dispose());
    expect(first.bytes).toEqual(expected); expect(second.bytes).toEqual(expected);
    expect(first.bytes.buffer).not.toBe(second.bytes.buffer);
    first.bytes.fill(7); expect(second.bytes).toEqual(expected);
    owner.dispose();
    expect(item.ledger.usage.bytes).toBe(expected.length * 2);
    expect(second.bytes).toEqual(expected);
    first.dispose(); first.dispose(); second.dispose();
    expect(() => first.bytes).toThrow(/disposed/);
  });
  it('copies exactly a typed-array subrange and ignores overridden instance getters', () => {
    const item = account(), source = encode(`bad${V2}bad`), view = source.subarray(3, source.length - 3);
    Object.defineProperty(view, 'byteLength', { get() { throw new Error('not the intrinsic'); } });
    Object.defineProperty(view, 'buffer', { get() { throw new Error('not the intrinsic'); } });
    const owner = item.parse(view), copy = owner.copyOriginal(item.options); cleanups.push(() => copy.dispose());
    expect(new TextDecoder().decode(copy.bytes)).toBe(V2);
  });
  it.each([new Int8Array(2), new Uint16Array(2), new DataView(new ArrayBuffer(2)), {}, null])(
    'case %#: refuses a non-Uint8Array byte owner %s before admission', value => {
      const item = account(); expect(() => item.parse(value as Uint8Array)).toThrow(); expect(item.amounts).toEqual([]);
    });
  it('refuses shared, resizable and detached original buffers before admission', () => {
    const item = account(), detached = encode(V2);
    structuredClone(detached.buffer, { transfer: [detached.buffer] });
    for (const bytes of [new Uint8Array(new SharedArrayBuffer(4)),
      new Uint8Array(Reflect.construct(ArrayBuffer, [4, { maxByteLength: 8 }]) as ArrayBuffer), detached])
      expect(() => item.parse(bytes)).toThrow();
    expect(item.amounts).toEqual([]);
  });
  it.each([0, 1, 2])('unwinds all prior reservations after admission refusal at stage %i', refusal => {
    const item = account(), original = item.admit;
    const admit = vi.fn((bytes: number) => {
      if (admit.mock.calls.length - 1 === refusal) throw new Error('admission refused');
      return original(bytes);
    });
    expect(() => parseSogMetadata(encode(V2), { admit, current() {} })).toThrow('admission refused');
    expect(item.ledger.usage.bytes).toBe(0);
  });
  it('refuses async hooks and observes their rejected promises', async () => {
    const item = account();
    expect(() => parseSogMetadata(encode(V2), { admit: item.admit, current: (() => Promise.reject('stale')) as () => void }))
      .toThrow(/synchronously/);
    expect(item.amounts).toEqual([]);
    expect(() => parseSogMetadata(encode(V2), {
      admit: (() => Promise.reject('refused')) as unknown as SogMetadataOptions['admit'], current() {},
    })).toThrow(/synchronously/);
    await Promise.resolve();
  });
  it('rejects reused and malformed leases without releasing any lease twice', () => {
    const item = account(), lease = item.admit(encode(V2).length * 2);
    expect(() => parseSogMetadata(encode(V2), { admit: () => lease, current() {} })).toThrow(/reused/);
    expect(item.ledger.usage.bytes).toBe(0);
    const invalid = vi.fn() as unknown as ResourceLease;
    expect(() => parseSogMetadata(encode(V2), { admit: () => invalid, current() {} })).toThrow(/lease/);
    expect(invalid).toHaveBeenCalledOnce();
  });
  it('captures and releases callable thenable/getter-failing admission leases', async () => {
    const item = account(), M = encode(V2).length;
    const thenable = item.admit(2 * M);
    Object.assign(thenable, { then(_resolve: unknown, reject: (reason: unknown) => void) { reject('invalid lease'); } });
    expect(() => parseSogMetadata(encode(V2), { admit: () => thenable, current() {} })).toThrow(/synchronously/);
    const getterBacking = item.ledger.reserve('source', 2 * M);
    const getterFailure = vi.fn(() => getterBacking()) as unknown as ResourceLease;
    bindResourceLeaseCredit(getterFailure, getterBacking);
    Object.defineProperty(getterFailure, 'bytes', { get() { throw new Error('failed byte getter'); } });
    expect(() => parseSogMetadata(encode(V2), { admit: () => getterFailure, current() {} })).toThrow('failed byte getter');
    expect(getterFailure).toHaveBeenCalledOnce(); await Promise.resolve();
  });
  it.each([0, 1, 2])('joins ownership when current fails immediately after admission stage %i', staleStage => {
    const item = account(); let stale = false, stage = 0;
    expect(() => parseSogMetadata(encode(V2), {
      admit(bytes) { const lease = item.admit(bytes); if (stage++ === staleStage) stale = true; return lease; },
      current() { if (stale) throw new Error('stale after admission'); },
    })).toThrow('stale after admission');
    expect(item.ledger.usage.bytes).toBe(0);
  });
  it('snapshots option/limit getters once and rejects stale access without freeing borrowed ownership', () => {
    const item = account(), reads: string[] = []; let stale = false;
    const owner = parseSogMetadata(encode(V2), {
      get admit() { reads.push('admit'); return item.admit; },
      get current() { reads.push('current'); return () => { if (stale) throw new Error('stale'); }; },
      get limits() { reads.push('limits'); return { get maxTokens() { reads.push('maxTokens'); return 42; } }; },
    });
    cleanups.push(() => owner.dispose());
    expect(reads).toEqual(['admit', 'current', 'limits', 'maxTokens']);
    const retained = item.ledger.usage.bytes; stale = true;
    expect(() => owner.declarations).toThrow('stale'); expect(() => owner.copyOriginal(item.options)).toThrow('stale');
    expect(item.ledger.usage.bytes).toBe(retained);
  });
  it('refuses a copy made stale during admission and retains the original owner', () => {
    const item = account(), owner = item.parse(V2), retained = item.ledger.usage.bytes; let stale = false;
    expect(() => owner.copyOriginal({ admit(bytes) { stale = true; return item.admit(bytes); },
      current() { if (stale) throw new Error('copy stale'); } })).toThrow('copy stale');
    expect(item.ledger.usage.bytes).toBe(retained); expect(owner.sourceCount).toBe(1);
  });
  it('authenticates only factory-issued current metadata for graph borrowing', () => {
    const item = account(), owner = item.parse(V2);
    expect(() => assertPreparedSogMetadata(owner)).not.toThrow();
    for (const value of [{ ...owner }, Object.create(owner), Object.freeze({ assertCurrent() {}, version: 2 }), null])
      expect(() => assertPreparedSogMetadata(value)).toThrow(/issued/);
    owner.dispose(); expect(() => assertPreparedSogMetadata(owner)).toThrow(/disposed/);
  });
  it('offers a factory-authenticated final alive barrier without current or lease getters', () => {
    const ledger = new ResourceLedger(1024 * 1024); let currentCalls = 0, creditReads = 0;
    const owner = parseSogMetadata(encode(V2), {
      admit(bytes) {
        const actual = ledger.reserve('source', bytes), lease = (() => actual()) as ResourceLease;
        Object.defineProperty(lease, 'bytes', { get() { creditReads++; return actual.bytes; } });
        lease.resize = bytes => actual.resize(bytes); return bindResourceLeaseCredit(lease, actual);
      }, current() { currentCalls++; },
    });
    cleanups.push(() => owner.dispose()); currentCalls = creditReads = 0;
    expect(() => assertPreparedSogMetadataAlive(owner)).not.toThrow();
    expect(currentCalls).toBe(0); expect(creditReads).toBe(0);
    expect(() => assertPreparedSogMetadataAlive({ ...owner })).toThrow(/issued/);
    owner.dispose(); currentCalls = creditReads = 0;
    expect(() => assertPreparedSogMetadataAlive(owner)).toThrow(/disposed/);
    expect(currentCalls).toBe(0); expect(creditReads).toBe(0); expect(ledger.usage.bytes).toBe(0);
  });
  it.each(['release', 'resize'] as const)('refuses externally %sd parser credit without exposing metadata', change => {
    const ledger = new ResourceLedger(1024 * 1024), leases: ResourceLease[] = [];
    const owner = parseSogMetadata(encode(V2), {
      admit(bytes) { const lease = ledger.reserve('source', bytes); leases.push(lease); return lease; }, current() {},
    });
    cleanups.push(() => owner.dispose());
    if (change === 'release') leases[1]!(); else leases[1]!.resize(leases[1]!.bytes - 1);
    expect(() => owner.declarations).toThrow(/credit changed/);
    expect(() => assertPreparedSogMetadata(owner)).toThrow(/credit changed/);
    expect(() => owner.copyOriginal({ admit: bytes => ledger.reserve('source', bytes), current() {} })).toThrow(/credit changed/);
    // The final barrier deliberately checks private liveness only; callers
    // must run the full current/credit assertion first.
    expect(() => assertPreparedSogMetadataAlive(owner)).not.toThrow();
    owner.dispose(); expect(ledger.usage).toMatchObject({ bytes: 0, allocations: 0 });
  });
  it('refuses current-hook retirement of newly admitted credit before graph materialization', () => {
    const ledger = new ResourceLedger(1024 * 1024); let lease: ResourceLease | undefined;
    const materialize = vi.spyOn(JSON, 'parse');
    expect(() => parseSogMetadata(encode(V2), {
      admit(bytes) { lease = ledger.reserve('source', bytes); return lease; },
      current() { lease?.(); },
    })).toThrow(/credit changed/);
    expect(materialize).not.toHaveBeenCalled(); expect(ledger.usage).toMatchObject({ bytes: 0, allocations: 0 });
  });
  it('checks private liveness after reentrant current and lease getter disposal', () => {
    for (const from of ['current', 'getter'] as const) {
      const ledger = new ResourceLedger(1024 * 1024); let owner: PreparedSogMetadata | undefined, armed = false;
      owner = parseSogMetadata(encode(V2), {
        admit(bytes) {
          const actual = ledger.reserve('source', bytes), lease = (() => actual()) as ResourceLease;
          Object.defineProperty(lease, 'bytes', { get() {
            const value = actual.bytes; if (armed && from === 'getter') owner!.dispose(); return value;
          } });
          lease.resize = bytes => actual.resize(bytes); return bindResourceLeaseCredit(lease, actual);
        }, current() { if (armed && from === 'current') owner!.dispose(); },
      });
      armed = true; expect(() => owner!.declarations).toThrow(/disposed/);
      expect(ledger.usage).toMatchObject({ bytes: 0, allocations: 0 }); owner.dispose();
    }
  });
  it.each(['release', 'resize'] as const)('refuses externally %sd independent copy credit after parser disposal', change => {
    const item = account(), owner = item.parse(V2), ledger = new ResourceLedger(1024 * 1024);
    let lease: ResourceLease | undefined;
    const copy = owner.copyOriginal({ admit(bytes) { lease = ledger.reserve('source', bytes); return lease; }, current() {} });
    cleanups.push(() => copy.dispose()); owner.dispose();
    if (change === 'release') lease!(); else lease!.resize(lease!.bytes - 1);
    expect(() => copy.bytes).toThrow(/credit changed/); copy.dispose();
    expect(ledger.usage).toMatchObject({ bytes: 0, allocations: 0 });
  });
  it('observes/refuses asynchronous lease cleanup while continuing every remaining release', async () => {
    const item = account(); let stage = 0;
    const owner = parseSogMetadata(encode(V2), {
      admit(bytes) {
        const lease = item.admit(bytes), selected = stage++ === 0;
        const release = (() => { lease(); if (selected) return Promise.reject('invalid asynchronous release'); }) as ResourceLease;
        Object.defineProperty(release, 'bytes', { get: () => lease.bytes }); release.resize = bytes => lease.resize(bytes);
        return bindResourceLeaseCredit(release, lease);
      }, current() {},
    });
    expect(() => owner.dispose()).toThrow(/synchronously/);
    expect(item.ledger.usage.bytes).toBe(0); owner.dispose(); await Promise.resolve();
  });
  it('preserves method hook receivers and propagates undefined cleanup failures after complete unwind', () => {
    const item = account(); let first = true;
    const methods = {
      admit(bytes: number) {
        expect(this).toBe(methods); const lease = item.admit(bytes), selected = first; first = false;
        const release = (() => { lease(); if (selected) throw undefined; }) as ResourceLease;
        Object.defineProperty(release, 'bytes', { get: () => lease.bytes }); release.resize = bytes => lease.resize(bytes);
        return bindResourceLeaseCredit(release, lease);
      },
      current() { expect(this).toBe(methods); },
    };
    const owner = parseSogMetadata(encode(V2), methods); let failed = false;
    try { owner.dispose(); } catch (error) { failed = true; expect(error).toBeUndefined(); }
    expect(failed).toBe(true); expect(item.ledger.usage.bytes).toBe(0); owner.dispose();
  });
});

describe('iterative JSON grammar and browser preparation ceilings', () => {
  it('freezes the reviewed defaults and permits only safe tighter limits', () => {
    expect(DEFAULT_SOG_METADATA_LIMITS).toEqual({ maxBytes: 16_777_216, maxDepth: 32, maxTokens: 65_536,
      maxStringUnits: 1_048_576, maxTotalStringUnits: 4_194_304, maxNumberCharacters: 128 });
    expect(Object.isFrozen(DEFAULT_SOG_METADATA_LIMITS)).toBe(true);
    const item = account();
    for (const limits of [{ maxTokens: 65_537 }, { maxTokens: 0 }, { maxTokens: .5 }, { maxTokens: NaN },
      { maxTokens: '42' }, { other: 1 }, []])
      expect(() => item.parse(V2, limits as Partial<SogMetadataLimits>)).toThrow();
    expect(item.amounts).toEqual([]);
  });
  it('accepts the exact byte ceiling and refuses ceiling+1 before admission', () => {
    const item = account(), M = encode(V2).length;
    expect(item.parse(V2, { maxBytes: M }).byteLength).toBe(M);
    const before = item.amounts.length;
    expect(() => item.parse(`${V2} `, { maxBytes: M })).toThrow(/byte limit/);
    expect(item.amounts.length).toBe(before);
  });
  it('checks the actual16MiB default before making a private copy', () => {
    const item = account(), bytes = new Uint8Array(16_777_216).fill(32); bytes.set(encode(V2));
    expect(item.parse(bytes).byteLength).toBe(16_777_216);
    const before = item.amounts.length;
    expect(() => item.parse(new Uint8Array(16_777_217))).toThrow(/byte limit/);
    expect(item.amounts.length).toBe(before);
  });
  it('counts root depth and checks exact32 versus33 without recursive preflight', () => {
    const item = account();
    expect(item.parse(extra(`${'['.repeat(31)}0${']'.repeat(31)}`)).stats.maxDepth).toBe(32);
    expect(() => item.parse(extra(`${'['.repeat(32)}0${']'.repeat(32)}`))).toThrow(/depth/);
    expect(() => item.parse(V2, { maxDepth: 2 })).toThrow(/depth/);
  });
  it('counts keys, containers and scalar values, including overwritten occurrences', () => {
    const item = account(); expect(item.parse(V2, { maxTokens: 42 }).stats.tokens).toBe(42);
    expect(() => item.parse(V2, { maxTokens: 41 })).toThrow(/token limit/);
    const duplicate = V2.replace('"count":1', '"count":2,"count":1');
    expect(item.parse(duplicate, { maxTokens: 44 }).sourceCount).toBe(1);
    expect(() => item.parse(duplicate, { maxTokens: 43 })).toThrow(/token limit/);
  });
  it('enforces the actual65,536 token default on unknown arrays', () => {
    const item = account(), text = extra(`[${'0,'.repeat(65_492 - 1)}0]`);
    // Base42 + unknown key1 + array1 + 65,492 scalar values.
    expect(item.parse(text).stats.tokens).toBe(65_536);
    expect(() => item.parse(extra(`[${'0,'.repeat(65_492)}0]`))).toThrow(/token limit/);
  });
  it('counts decoded UTF16 units independently of escape/UTF8 spelling', () => {
    const item = account();
    for (const text of [extra('"abc"'), extra('"\\u0061\\u0062\\u0063"')])
      expect(item.parse(text, { maxTotalStringUnits: 84 }).stats.stringUnits).toBe(84);
    expect(() => item.parse(extra('"abc"'), { maxTotalStringUnits: 83 })).toThrow(/string limit/);
    expect(item.parse(extra('"😀"')).stats.stringUnits).toBe(83);
    expect(item.parse(extra('"\\ud83d\\ude00"')).stats.stringUnits).toBe(83);
    expect(item.parse(V2, { maxStringUnits: 8 }).sourceCount).toBe(1);
    expect(() => item.parse(extra('"123456789"'), { maxStringUnits: 8 })).toThrow(/string limit/);
  });
  it('enforces the actual individual and cumulative string defaults', () => {
    const item = account();
    expect(item.parse(extra(JSON.stringify('a'.repeat(1_048_576)))).stats.stringUnits).toBe(1_048_657);
    expect(() => item.parse(extra(JSON.stringify('a'.repeat(1_048_577))))).toThrow(/string limit/);
    const unknown = ['a'.repeat(1_048_576), 'b'.repeat(1_048_576), 'c'.repeat(1_048_576), 'd'.repeat(1_048_495)];
    expect(item.parse(extra(JSON.stringify(unknown))).stats.stringUnits).toBe(4_194_304);
    unknown[3] += 'd'; expect(() => item.parse(extra(JSON.stringify(unknown)))).toThrow(/string limit/);
  });
  it('checks numeric token length before conversion and rejects nonfinite conversion', () => {
    const item = account(), numeric = `0.${'0'.repeat(125)}1`;
    expect(numeric.length).toBe(128); expect(item.parse(extra(numeric)).sourceCount).toBe(1);
    expect(() => item.parse(extra(`${numeric}0`))).toThrow(/numeric token/);
    expect(() => item.parse(extra('1e999'))).toThrow(/nonfinite/);
    expect(item.parse(extra('-0e-999')).sourceCount).toBe(1);
  });
  it.each(['', ' ', '{', '[', '{} trailing', '[]', 'null', 'true', '1',
    '{"x":}', '{"x":1,}', '{"x" 1}', '{"x":01}', '{"x":+1}', '{"x":.1}',
    '{"x":1.}', '{"x":1e}', '{"x":--1}', '{"x":undefined}', '{"x":[1,]}',
    '{"x":[,1]}', '{"x":tru}', '{"x":"\\x20"}', '{"x":"\\uQQQQ"}',
    '{"x":"\\ud800"}', '{"x":"\\udc00"}', '{"x":"\\ud800\\u0041"}', '{"x":"line\nfeed"}']) (
    'refuses malformed grammar or non-object metadata %j with complete unwind', text => {
      const item = account(); expect(() => item.parse(text)).toThrow(); expect(item.ledger.usage.bytes).toBe(0);
    });
  it('refuses malformed UTF8 before constructing any JSON graph', () => {
    const item = account(), materialize = vi.spyOn(JSON, 'parse');
    for (const bytes of [[0xc0, 0xaf], [0xe2, 0x82], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0x80]])
      expect(() => item.parse(new Uint8Array(bytes))).toThrow();
    expect(materialize).not.toHaveBeenCalled();
  });
  it('preserves a leading UTF8 BOM in original bytes while parsing its JSON payload', () => {
    const item = account(), bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...encode(V2)]), owner = item.parse(bytes);
    const copy = owner.copyOriginal(item.options); cleanups.push(() => copy.dispose());
    expect(owner.version).toBe(2); expect(copy.bytes).toEqual(bytes);
  });
});

describe('source-reviewed SOG static schema and deferred texture conditions', () => {
  it.each([undefined, 1, true, 1.9])('preserves legacy default/native version conversion %s', version => {
    const item = account(), value = v1(); if (version !== undefined) value.version = version;
    const owner = item.parse(JSON.stringify(value)); expect(owner.version).toBe(1); expect(owner.sourceCount).toBe(3);
  });
  it.each([2, 2.9])('preserves version2 numeric conversion %s', version => {
    const item = account(), value = v2(); value.version = version;
    expect(item.parse(JSON.stringify(value)).version).toBe(2);
  });
  it.each([null, '1', false, 0, -1, 3, 2_147_483_648, 9_007_199_254_740_992])('refuses unsupported version %s', version => {
    const item = account(), value = v2(); value.version = version; expect(() => item.parse(JSON.stringify(value))).toThrow();
  });
  it.each([1, 10_000_000, 3.9])('preserves bounded source-count native conversion %s', count => {
    const item = account(), modern = v2(), legacy = v1(); modern.count = count; legacy.means.shape[0] = count;
    const expected = Math.trunc(count);
    expect(item.parse(JSON.stringify(modern)).sourceCount).toBe(expected);
    expect(item.parse(JSON.stringify(legacy)).sourceCount).toBe(expected);
  });
  it.each([0, false, true, -1, 10_000_001, '3', null, 9_007_199_254_740_992])('refuses source count %s', count => {
    const item = account(), modern = v2(), legacy = v1(); modern.count = count; legacy.means.shape[0] = count;
    expect(() => item.parse(JSON.stringify(modern))).toThrow(); expect(() => item.parse(JSON.stringify(legacy))).toThrow();
  });
  it('validates legacy shape with native truncation and required width', () => {
    const item = account(), value = v1(); value.means.shape = [3.9, 3.9];
    expect(item.parse(JSON.stringify(value)).sourceCount).toBe(3);
    for (const shape of [null, [], [3], [3, 2], [3, 3, 3], ['3', 3]]) {
      value.means.shape = shape; expect(() => item.parse(JSON.stringify(value))).toThrow();
    }
  });
  it.each(['means', 'scales', 'quats', 'sh0'])('requires non-null group %s', group => {
    const item = account(); for (const replacement of [null, [], 1, undefined]) {
      const value = v2(); if (replacement === undefined) delete value[group]; else value[group] = replacement;
      expect(() => item.parse(JSON.stringify(value))).toThrow();
    }
  });
  it.each(['means', 'scales', 'quats', 'sh0', 'shN'])('checks file arity/string type and includes extras in %s', group => {
    const item = account(), value = v2(); value.shN = { files: ['centroid', 'labels'], bands: 1, count: 1, codebook: [0] };
    const minimum = group === 'means' || group === 'shN' ? 2 : 1;
    for (const files of [[], Array(minimum - 1).fill('x'), Array(9).fill('x'), ['x', 3]]) {
      value[group].files = files; expect(() => item.parse(JSON.stringify(value))).toThrow();
    }
    value[group].files = Array.from({ length: 8 }, (_, index) => `resource-${index}`);
    expect(item.parse(JSON.stringify(value)).declarations.filter(entry => entry.group === group))
      .toEqual(Array.from({ length: 8 }, (_, index) => ({ group, index, reference: `resource-${index}` })));
  });
  it('retains all40 final declarations while ignoring unknown and overwritten resource groups', () => {
    const item = account(), value = v2(); value.shN = { bands: 3, count: 65_536, codebook: [0] };
    for (const group of ['means', 'scales', 'quats', 'sh0', 'shN']) value[group].files = Array(8).fill(group);
    value.unknown = { files: ['unrelated'] };
    const text = JSON.stringify(value).replace('"quats":', '"quats":{"files":["overwritten"]},"quats":');
    const owner = item.parse(text); expect(owner.declarations).toHaveLength(40);
    expect(owner.declarations.some(entry => ['unrelated', 'overwritten'].includes(entry.reference))).toBe(false);
  });
  it('recognizes escaped duplicate keys with last-key-wins values and full census', () => {
    const item = account();
    const text = V2.replace('"count":1', '"count":9,"co\\u0075nt":1')
      .replace('"files":["a","b"]', '"files":["old","old2"],"f\\u0069les":["a","b"]');
    const owner = item.parse(text); expect(owner.sourceCount).toBe(1);
    expect(owner.declarations.slice(0, 2).map(entry => entry.reference)).toEqual(['a', 'b']);
    expect(owner.stats.tokens).toBe(48); expect(owner.stats.stringUnits).toBe(97);
  });
  it('does not interpret unknown __proto__ or constructor fields as schema/prototype mutations', () => {
    const item = account(), owner = item.parse(extra('{"files":["outside"],"polluted":true}', '__proto__'));
    expect(owner.declarations).toHaveLength(5); expect(Object.hasOwn({}, 'polluted')).toBe(false);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
  it('uses float32-converted finite ordered position/legacy bounds', () => {
    const item = account(), value = v1(); value.means.mins = [false, 0, 0]; value.means.maxs = [true, 40.0000001, 1];
    expect(item.parse(JSON.stringify(value)).version).toBe(1);
    for (const [group, key, replacement] of [['means', 'mins', [0, 0]], ['means', 'maxs', [1, 40.1, 1]],
      ['means', 'mins', [2, 0, 0]], ['means', 'maxs', [1e100, 1, 1]],
      ['scales', 'mins', [2, 0, 0]], ['sh0', 'maxs', [0, 0, 0]], ['sh0', 'mins', ['0', 0, 0, 0]]] as const) {
      const changed = v1(); changed[group][key] = replacement; expect(() => item.parse(JSON.stringify(changed))).toThrow();
    }
  });
  it('bounds codebooks but defers float32 finiteness of unused indexed entries', () => {
    const item = account(), value = v2(); value.scales.codebook = [0, true, false, 1e100];
    expect(item.parse(JSON.stringify(value)).version).toBe(2);
    value.scales.codebook = Array(256).fill(0); expect(item.parse(JSON.stringify(value)).version).toBe(2);
    for (const book of [[], Array(257).fill(0), null, ['0'], [null], [{}]]) {
      value.scales.codebook = book; expect(() => item.parse(JSON.stringify(value))).toThrow();
    }
    delete value.scales.codebook; expect(() => item.parse(JSON.stringify(value))).toThrow();
  });
  it('treats absent/null SHN as SH0 and defers legacy degree to centroid dimensions', () => {
    const item = account(), legacy = v1(), modern = v2();
    for (const value of [legacy, modern]) {
      expect(item.parse(JSON.stringify(value)).shDegree).toBe(0);
      value.shN = null; expect(item.parse(JSON.stringify(value)).shDegree).toBe(0);
    }
    legacy.shN = { files: ['centroids', 'labels'], mins: -1, maxs: 1 };
    expect(item.parse(JSON.stringify(legacy)).shDegree).toBeNull();
    legacy.shN.mins = 2; expect(() => item.parse(JSON.stringify(legacy))).toThrow();
  });
  it.each([1, 2, 3, true, 2.9])('normalizes v2 SH bands %s with palette/codebook checks', bands => {
    const item = account(), value = v2(); value.shN = { files: ['centroids', 'labels'], bands, count: 65_536, codebook: [0, 1e100] };
    expect(item.parse(JSON.stringify(value)).shDegree).toBe(typeof bands === 'boolean' ? Number(bands) : Math.trunc(bands));
  });
  it.each([1, 1.9, 65_536, 65_536.9])('preserves numeric palette %s while validating captured truncated Windows size_t bounds', count => {
    const item = account(), value = v2(); value.shN = { files: ['centroids', 'labels'], bands: true, count, codebook: [0] };
    const owner = item.parse(JSON.stringify(value)); expect(owner.shDegree).toBe(1);
    const copied = owner.copyOriginal(item.options);
    try { expect(JSON.parse(new TextDecoder().decode(copied.bytes)).shN.count).toBe(count); }
    finally { copied.dispose(); }
  });
  it.each([['bands', 0], ['bands', 4], ['bands', '1'], ['count', 0], ['count', .9], ['count', -1], ['count', 65_537], ['count', true], ['count', false], ['count', '1'],
    ['count', null], ['codebook', []], ['codebook', ['0']]])('refuses SH %s=%s', (key, replacement) => {
    const item = account(), value = v2(); value.shN = { files: ['centroids', 'labels'], bands: 1, count: 1, codebook: [0] };
    value.shN[key] = replacement; expect(() => item.parse(JSON.stringify(value))).toThrow();
  });
});
