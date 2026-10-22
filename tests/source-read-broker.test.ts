import { describe, expect, it } from 'vitest';
import { ResourceLedger, type ResourceLease } from '../src/document/resources';
import { MAX_SOURCE_READ_BYTES, SourceReadBroker, type SourceReadDescriptor, type SourceReadOptions,
  type SourceReadRequest } from '../src/io/readBroker';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function descriptor(byteLength: number): SourceReadDescriptor {
  return { operationId: 'candidate-operation', resourceId: 'source-resource', byteLength };
}
function request(offset: number, length: number): SourceReadRequest {
  return { operationId: 'candidate-operation', resourceId: 'source-resource', offset, length };
}
function fixture(data = [11, 22, 33, 44], read?: () => Promise<unknown>) {
  const file = new Blob([new Uint8Array(data)]), slices: number[][] = [];
  const originalSlice = file.slice;
  Object.defineProperty(file, 'slice', { configurable: true, value(start: number, end: number) {
    slices.push([start, end]);
    const part = originalSlice.call(file, start, end);
    if (read) Object.defineProperty(part, 'arrayBuffer', { value: read });
    return part;
  } });
  const ledger = new ResourceLedger(2 * MAX_SOURCE_READ_BYTES);
  let releases = 0;
  const admitted: number[] = [];
  const options: SourceReadOptions = { current: () => undefined, admit(bytes) {
    admitted.push(bytes);
    const lease = ledger.reserve('source', bytes);
    const tracked = (() => { releases++; lease(); }) as ResourceLease;
    Object.defineProperty(tracked, 'bytes', { get: () => lease.bytes });
    tracked.resize = bytes => lease.resize(bytes);
    return tracked;
  } };
  return { file, slices, ledger, admitted, options, releases: () => releases,
    broker: () => new SourceReadBroker(file, descriptor(file.size), options) };
}
async function microtasks(): Promise<void> { await Promise.resolve(); await Promise.resolve(); }

describe('bounded source Blob read ownership', () => {
  it('snapshots descriptor and option getters once before any asynchronous read', async () => {
    const input = fixture(), counts = { operation: 0, resource: 0, size: 0, admit: 0, current: 0 };
    let operationId = 'candidate-operation', resourceId = 'source-resource', byteLength = 4, currentCalls = 0;
    const source = {
      get operationId() { counts.operation++; return operationId; },
      get resourceId() { counts.resource++; return resourceId; },
      get byteLength() { counts.size++; return byteLength; },
    };
    const options = {
      get admit() { counts.admit++; return input.options.admit; },
      get current() { counts.current++; return () => { currentCalls++; }; },
    };
    const broker = new SourceReadBroker(input.file, source, options);
    operationId = 'changed'; resourceId = 'changed'; byteLength = 99;
    expect(counts).toEqual({ operation: 1, resource: 1, size: 1, admit: 1, current: 1 });
    expect(broker.descriptor).toEqual(descriptor(4)); expect(Object.isFrozen(broker.descriptor)).toBe(true);
    expect(() => { (broker.descriptor as { resourceId: string }).resourceId = 'other'; }).toThrow();
    const chunk = await broker.read(request(0, 4));
    expect([...new Uint8Array(chunk.bytes)]).toEqual([11, 22, 33, 44]); chunk.consume();
    expect(currentCalls).toBeGreaterThanOrEqual(3); expect(broker.complete).toBe(true);
    await broker.retire(); expect(input.releases()).toBe(1);
  });

  it.each([
    ['operation empty', { operationId: '' }], ['resource empty', { resourceId: '' }],
    ['operation too long', { operationId: 'o'.repeat(129) }], ['resource too long', { resourceId: 'r'.repeat(129) }],
    ['numeric operation', { operationId: 1 }], ['numeric resource', { resourceId: 1 }],
    ['null operation', { operationId: null }], ['null resource', { resourceId: null }],
    ['negative bytes', { byteLength: -1 }], ['fractional bytes', { byteLength: 3.5 }],
    ['unsafe bytes', { byteLength: Number.MAX_SAFE_INTEGER + 1 }], ['infinite bytes', { byteLength: Infinity }],
    ['NaN bytes', { byteLength: NaN }], ['string bytes', { byteLength: '4' }],
    ['bigint bytes', { byteLength: 4n }], ['different Blob bytes', { byteLength: 3 }],
  ] as const)('rejects descriptor %s without reading', (_label, change) => {
    const input = fixture();
    expect(() => new SourceReadBroker(input.file, { ...descriptor(4), ...change } as SourceReadDescriptor, input.options)).toThrow();
    expect(input.slices).toEqual([]); expect(input.ledger.usage.bytes).toBe(0);
  });

  it('accepts exact 128-unit opaque IDs and compares them without coercion', async () => {
    const input = fixture(), source = { operationId: 'o'.repeat(128), resourceId: 'r'.repeat(128), byteLength: 4 };
    const broker = new SourceReadBroker(input.file, source, input.options);
    const chunk = await broker.read({ ...source, offset: 0, length: 4 }); chunk.consume(); await broker.retire();
    expect(input.releases()).toBe(1);
  });

  it.each([null, [], {}, { size: 4, slice: () => new Blob() }])('refuses a non-Blob source %j', file => {
    const input = fixture();
    expect(() => new SourceReadBroker(file as Blob, descriptor(4), input.options)).toThrow();
    expect(input.admitted).toEqual([]);
  });

  it.each([null, [], {}, { admit: null, current: () => undefined }, { admit: () => undefined, current: null }])
  ('refuses invalid options %j', options => {
    const input = fixture();
    expect(() => new SourceReadBroker(input.file, descriptor(4), options as unknown as SourceReadOptions)).toThrow();
    expect(input.slices).toEqual([]);
  });

  it('uses intrinsic Blob size rather than a forged own size property', async () => {
    const input = fixture(); Object.defineProperty(input.file, 'size', { value: 99 });
    const broker = new SourceReadBroker(input.file, descriptor(4), input.options);
    const chunk = await broker.read(request(0, 4)); expect(chunk.bytes.byteLength).toBe(4); chunk.consume();
    await broker.retire(); expect(input.slices).toEqual([[0, 4]]);
  });

  it('completes an empty resource without issuing a zero-byte range', async () => {
    const input = fixture([]), broker = input.broker(); expect(broker.complete).toBe(true);
    await expect(broker.read(request(0, 0))).rejects.toThrow();
    expect(input.slices).toEqual([]); expect(input.admitted).toEqual([]); await broker.retire();
  });

  it('reads exact sequential ranges and advances only on consumption acknowledgement', async () => {
    const input = fixture(), broker = input.broker();
    const first = await broker.read(request(0, 3));
    expect([...new Uint8Array(first.bytes)]).toEqual([11, 22, 33]);
    expect(broker.pending).toBe(true); expect(broker.consumedBytes).toBe(0); expect(input.ledger.usage.bytes).toBe(6);
    first.consume(); expect(broker.consumedBytes).toBe(3); expect(broker.pending).toBe(false);
    const last = await broker.read(request(3, 1)); expect([...new Uint8Array(last.bytes)]).toEqual([44]);
    last.consume(); expect(broker.complete).toBe(true); expect(input.slices).toEqual([[0, 3], [3, 4]]);
    expect(input.admitted).toEqual([6, 2]); expect(input.releases()).toBe(2); expect(input.ledger.usage.bytes).toBe(0);
    await expect(broker.read(request(4, 1))).rejects.toThrow(); await broker.retire();
  });

  it('permits one exact 1-MiB range followed by a short final range', async () => {
    const bytes = new Uint8Array(MAX_SOURCE_READ_BYTES + 1); bytes[0] = 19; bytes[MAX_SOURCE_READ_BYTES] = 71;
    const file = new Blob([bytes]), ledger = new ResourceLedger(2 * MAX_SOURCE_READ_BYTES);
    const broker = new SourceReadBroker(file, descriptor(file.size), { current: () => undefined, admit: n => ledger.reserve('source', n) });
    const first = await broker.read(request(0, MAX_SOURCE_READ_BYTES)); expect(new Uint8Array(first.bytes)[0]).toBe(19);
    expect(ledger.usage.bytes).toBe(2 * MAX_SOURCE_READ_BYTES); first.consume();
    const last = await broker.read(request(MAX_SOURCE_READ_BYTES, 1)); expect([...new Uint8Array(last.bytes)]).toEqual([71]);
    last.consume(); expect(broker.complete).toBe(true); expect(ledger.usage.bytes).toBe(0); await broker.retire();
  });

  it('holds exactly one credit during the actual read and delivered chunk lifetime', async () => {
    const gate = deferred<unknown>(), input = fixture(undefined, () => gate.promise), broker = input.broker();
    const reading = broker.read(request(0, 2));
    await expect(broker.read(request(0, 2))).rejects.toThrow(/credit/);
    await expect(broker.read(request(2, 2))).rejects.toThrow();
    expect(input.slices).toEqual([[0, 2]]); expect(input.admitted).toEqual([4]);
    gate.resolve(new Uint8Array([11, 22]).buffer); const chunk = await reading;
    await expect(broker.read(request(0, 2))).rejects.toThrow(/credit/);
    expect(input.ledger.usage.bytes).toBe(4); expect(broker.consumedBytes).toBe(0);
    chunk.consume(); expect(input.releases()).toBe(1); await broker.retire();
  });

  it.each([
    ['wrong operation', { operationId: 'other' }], ['wrong resource', { resourceId: 'other' }],
    ['numeric operation', { operationId: 1 }], ['numeric resource', { resourceId: 1 }],
    ['foreign family without source identities', { operationId: undefined, resourceId: undefined, type: 'map-chunk-request' }],
    ['gap', { offset: 1 }], ['negative offset', { offset: -1 }], ['fractional offset', { offset: 0.5 }],
    ['unsafe offset', { offset: Number.MAX_SAFE_INTEGER + 1 }], ['string offset', { offset: '0' }],
    ['NaN offset', { offset: NaN }], ['infinite offset', { offset: Infinity }],
    ['zero length', { length: 0 }], ['negative length', { length: -1 }], ['fractional length', { length: 1.5 }],
    ['string length', { length: '4' }], ['oversize length', { length: MAX_SOURCE_READ_BYTES + 1 }],
    ['past end', { length: 5 }], ['unsafe length', { length: Number.MAX_SAFE_INTEGER + 1 }],
    ['NaN length', { length: NaN }], ['infinite length', { length: Infinity }],
  ] as const)('rejects %s before admission or Blob access', async (_label, change) => {
    const input = fixture(), broker = input.broker();
    await expect(broker.read({ ...request(0, 4), ...change } as SourceReadRequest)).rejects.toThrow();
    expect(input.admitted).toEqual([]); expect(input.slices).toEqual([]); expect(broker.consumedBytes).toBe(0);
    const chunk = await broker.read(request(0, 4)); chunk.consume(); await broker.retire();
  });

  it('refuses duplicate ranges and duplicate consumption without canceling a successor', async () => {
    const input = fixture(), broker = input.broker(), first = await broker.read(request(0, 2)); first.consume();
    await expect(broker.read(request(0, 2))).rejects.toThrow();
    const second = await broker.read(request(2, 2));
    expect(() => first.consume()).toThrow(); first.release();
    expect(broker.pending).toBe(true); expect(input.ledger.usage.bytes).toBe(4);
    second.consume(); expect(broker.complete).toBe(true); expect(input.releases()).toBe(2); await broker.retire();
  });

  it('retains the lease and read owner after cancel and simulated worker disposal until actual Blob settlement', async () => {
    const gate = deferred<unknown>(), input = fixture(undefined, () => gate.promise), broker = input.broker();
    const reading = broker.read(request(0, 4)), reason = new DOMException('Replaced document', 'AbortError');
    const rejected = expect(reading).rejects.toBe(reason);
    broker.cancel(reason);
    const workerDisposed = true, retiring = broker.retire();
    expect(broker.retire()).toBe(retiring);
    let retired = false; void retiring.then(() => { retired = true; }); await microtasks();
    expect(workerDisposed).toBe(true); expect(retired).toBe(false); expect(broker.pending).toBe(true);
    expect(input.ledger.usage.bytes).toBe(8); expect(input.releases()).toBe(0);
    await expect(broker.read(request(0, 4))).rejects.toBe(reason); expect(input.slices).toHaveLength(1);
    gate.resolve(new Uint8Array([11, 22, 33, 44]).buffer);
    await rejected; await retiring;
    expect(broker.pending).toBe(false); expect(broker.consumedBytes).toBe(0); expect(retired).toBe(true);
    expect(input.ledger.usage.bytes).toBe(0); expect(input.releases()).toBe(1);
    broker.cancel(); await broker.retire(); expect(input.releases()).toBe(1);
    await expect(broker.read(request(0, 4))).rejects.toBe(reason); expect(input.slices).toHaveLength(1);
  });

  it('joins a canceled Blob read that rejects rather than resolves', async () => {
    const gate = deferred<unknown>(), input = fixture(undefined, () => gate.promise), broker = input.broker();
    const error = new Error('Disk read failed'), reading = broker.read(request(0, 4));
    const rejected = expect(reading).rejects.toBe(error); broker.cancel(); const retiring = broker.retire();
    await microtasks(); expect(input.ledger.usage.bytes).toBe(8); gate.reject(error);
    await rejected; await retiring; expect(input.releases()).toBe(1); expect(input.ledger.usage.bytes).toBe(0);
  });

  it('revokes a delivered chunk immediately and late consume cannot advance or release twice', async () => {
    const input = fixture(), broker = input.broker(), chunk = await broker.read(request(0, 4));
    const reason = new Error('Candidate lost'); broker.cancel(reason);
    expect(input.ledger.usage.bytes).toBe(0); expect(input.releases()).toBe(1); expect(broker.pending).toBe(false);
    expect(() => chunk.bytes).toThrow(reason); expect(() => chunk.consume()).toThrow(reason);
    chunk.release(); broker.cancel(); await broker.retire();
    expect(broker.consumedBytes).toBe(0); expect(input.releases()).toBe(1);
  });

  it('abandoning a delivered chunk is idempotent, cancels publication and preserves its offset', async () => {
    const input = fixture(), broker = input.broker(), chunk = await broker.read(request(0, 4));
    chunk.release(); chunk.release(); expect(() => chunk.consume()).toThrow(); expect(() => chunk.bytes).toThrow();
    await expect(broker.read(request(0, 4))).rejects.toThrow();
    expect(input.releases()).toBe(1); expect(broker.consumedBytes).toBe(0); await broker.retire();
  });

  it('holds reservation through synchronous transfer then permits acknowledgement of detached bytes', async () => {
    const input = fixture(), broker = input.broker(), chunk = await broker.read(request(0, 2));
    const borrowed = chunk.bytes; expect(input.ledger.usage.bytes).toBe(4);
    const receiver = structuredClone(borrowed, { transfer: [borrowed] });
    expect(borrowed.byteLength).toBe(0); expect([...new Uint8Array(receiver)]).toEqual([11, 22]);
    expect(input.ledger.usage.bytes).toBe(4); chunk.consume(); expect(input.ledger.usage.bytes).toBe(0);
    const last = await broker.read(request(2, 2)); chunk.release(); last.consume();
    expect(broker.complete).toBe(true); expect(input.releases()).toBe(2); await broker.retire();
  });

  it('a failed synchronous transfer abandons its chunk without advancing', async () => {
    const input = fixture(), broker = input.broker(), chunk = await broker.read(request(0, 4));
    const transfer = () => { throw new Error('postMessage refused'); };
    try { transfer(); chunk.consume(); } catch { chunk.release(); }
    expect(broker.consumedBytes).toBe(0); expect(input.releases()).toBe(1);
    await expect(broker.read(request(0, 4))).rejects.toThrow(); await broker.retire();
  });

  it('refuses admission before slice or arrayBuffer starts and preserves zero usage', async () => {
    const input = fixture(), ledger = new ResourceLedger(7);
    const broker = new SourceReadBroker(input.file, descriptor(4), { current: () => undefined, admit: n => ledger.reserve('source', n) });
    await expect(broker.read(request(0, 4))).rejects.toThrow();
    expect(input.slices).toEqual([]); expect(ledger.usage.bytes).toBe(0); expect(broker.pending).toBe(false); await broker.retire();
  });

  it('checks current before admission and cancels a failed owner permanently', async () => {
    const input = fixture(), reason = new Error('Stale operation'); let stale = true;
    input.options.current = () => { if (stale) throw reason; };
    const broker = input.broker(); await expect(broker.read(request(0, 4))).rejects.toBe(reason);
    stale = false; await expect(broker.read(request(0, 4))).rejects.toBe(reason);
    expect(input.admitted).toEqual([]); expect(input.slices).toEqual([]); await broker.retire();
  });

  it('checks current after the actual read before returning its buffer', async () => {
    const gate = deferred<unknown>(), input = fixture(undefined, () => gate.promise), reason = new Error('New winner'); let stale = false;
    input.options.current = () => { if (stale) throw reason; };
    const broker = input.broker(), reading = broker.read(request(0, 4));
    const rejected = expect(reading).rejects.toBe(reason);
    stale = true; expect(input.ledger.usage.bytes).toBe(8); gate.resolve(new ArrayBuffer(4)); await rejected;
    expect(input.releases()).toBe(1); expect(broker.consumedBytes).toBe(0); await broker.retire();
  });

  it('checks current again before consumption and refuses stale acknowledgement', async () => {
    const input = fixture(), reason = new Error('Replaced after delivery'); let stale = false;
    input.options.current = () => { if (stale) throw reason; };
    const broker = input.broker(), chunk = await broker.read(request(0, 4)); stale = true;
    expect(() => chunk.consume()).toThrow(reason); expect(broker.consumedBytes).toBe(0);
    expect(input.releases()).toBe(1); await broker.retire();
  });

  it('handles cancellation reentrantly during admission without starting a Blob read', async () => {
    const input = fixture(), admit = input.options.admit, reason = new Error('Canceled during admission');
    let broker!: SourceReadBroker;
    input.options.admit = n => { const lease = admit(n); broker.cancel(reason); return lease; };
    broker = input.broker(); await expect(broker.read(request(0, 4))).rejects.toBe(reason);
    expect(input.slices).toEqual([]); expect(input.releases()).toBe(1); expect(input.ledger.usage.bytes).toBe(0); await broker.retire();
  });

  it('joins retirement requested reentrantly during admission and releases the subsequently returned lease', async () => {
    const input = fixture(), admit = input.options.admit;
    let broker!: SourceReadBroker, retirement: Promise<void> | undefined;
    input.options.admit = n => { retirement = broker.retire(); return admit(n); };
    broker = input.broker(); await expect(broker.read(request(0, 4))).rejects.toThrow(); await retirement;
    expect(input.slices).toEqual([]); expect(input.releases()).toBe(1); expect(input.ledger.usage.bytes).toBe(0);
    expect(broker.retire()).toBe(retirement);
  });

  it('joins a Blob promise whose invocation synchronously cancels the owner', async () => {
    const gate = deferred<unknown>(); let broker!: SourceReadBroker;
    const input = fixture(undefined, () => { broker.cancel(); return gate.promise; }); broker = input.broker();
    const reading = broker.read(request(0, 4)), rejected = expect(reading).rejects.toThrow();
    const retirement = broker.retire(); await microtasks(); expect(input.ledger.usage.bytes).toBe(8);
    gate.resolve(new ArrayBuffer(4)); await rejected; await retirement;
    expect(input.releases()).toBe(1); expect(broker.consumedBytes).toBe(0);
  });

  it.each([
    ['short', (): unknown => new ArrayBuffer(3)], ['long', (): unknown => new ArrayBuffer(5)],
    ['view', (): unknown => new Uint8Array(4)], ['null', (): unknown => null], ['plain', (): unknown => ({ byteLength: 4 })],
    ['forged prototype', (): unknown => Object.create(ArrayBuffer.prototype)],
    ['forged tag', (): unknown => ({ [Symbol.toStringTag]: 'ArrayBuffer', byteLength: 4 })],
    ['shared', (): unknown => new SharedArrayBuffer(4)],
    ['resizable', (): unknown => Reflect.construct(ArrayBuffer, [4, { maxByteLength: 8 }])],
    ['detached', (): unknown => { const bytes = new ArrayBuffer(4); structuredClone(bytes, { transfer: [bytes] }); return bytes; }],
  ] as const)('rejects malformed %s results with exact single release', async (_label, value) => {
    const input = fixture(undefined, () => Promise.resolve(value())), broker = input.broker();
    await expect(broker.read(request(0, 4))).rejects.toThrow();
    expect(broker.consumedBytes).toBe(0); expect(broker.pending).toBe(false); expect(input.releases()).toBe(1);
    expect(input.ledger.usage.bytes).toBe(0); await broker.retire(); expect(input.releases()).toBe(1);
  });

  it('releases once after a synchronous slice failure', async () => {
    const input = fixture(), reason = new Error('slice failed');
    Object.defineProperty(input.file, 'slice', { value: () => { throw reason; } });
    const broker = input.broker(); await expect(broker.read(request(0, 4))).rejects.toBe(reason);
    expect(input.releases()).toBe(1); expect(input.ledger.usage.bytes).toBe(0); await broker.retire();
  });

  it('releases once after a synchronous arrayBuffer failure', async () => {
    const reason = new Error('arrayBuffer failed'), input = fixture(undefined, () => { throw reason; }), broker = input.broker();
    await expect(broker.read(request(0, 4))).rejects.toBe(reason);
    expect(input.releases()).toBe(1); expect(input.ledger.usage.bytes).toBe(0); await broker.retire();
  });

  it('rejects a non-promise arrayBuffer result rather than accepting a forged API', async () => {
    const input = fixture(undefined, (() => new ArrayBuffer(4)) as unknown as () => Promise<unknown>), broker = input.broker();
    await expect(broker.read(request(0, 4))).rejects.toThrow(/promise/);
    expect(input.releases()).toBe(1); expect(input.ledger.usage.bytes).toBe(0); await broker.retire();
  });

  it('rejects malformed admission leases without reading', async () => {
    const input = fixture(); input.options.admit = (() => ({})) as unknown as SourceReadOptions['admit'];
    const broker = input.broker(); await expect(broker.read(request(0, 4))).rejects.toThrow(/reservation/);
    expect(input.slices).toEqual([]); expect(broker.pending).toBe(false); await broker.retire();
  });

  it('releases a real but incorrectly sized admission lease exactly once', async () => {
    const input = fixture(), admit = input.options.admit;
    input.options.admit = n => admit(n - 1); const broker = input.broker();
    await expect(broker.read(request(0, 4))).rejects.toThrow(/reservation/);
    expect(input.slices).toEqual([]); expect(input.ledger.usage.bytes).toBe(0); expect(input.releases()).toBe(1); await broker.retire();
  });
});
