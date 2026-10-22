import { describe, expect, it } from 'vitest';
import { SelectionMapCache, type SelectionMapSource } from '../src/document/selectionMapCache';
import { ResourceLedger } from '../src/document/resources';
import type { SurfaceMap, SurfaceRegion } from '../src/renderer/webgpu/surfaceQuery';
import type { AdoptedSelectionMap } from '../src/document/selectionMap';
import type { NativeSummary } from '../src/document/types';

function deferred() {
  let resolve!: () => void;
  return { promise: new Promise<void>(value => { resolve = value; }), resolve: () => resolve() };
}
function fixture() {
  const ledger = new ResourceLedger(1024), cache = new SelectionMapCache();
  let calls = 0, adoptions = 0, active = 0, nextId = 0, stale = false, refuse = false;
  let gate: ReturnType<typeof deferred> | undefined;
  const requests: { region?: SurfaceRegion; colors?: boolean; visible?: boolean }[] = [];
  const entered = deferred();
  const source: SelectionMapSource = {
    key: 'view-a', sourceCount: 1,
    current() { if (stale) throw new Error('View expired'); },
    admit: bytes => ledger.reserve('work', bytes),
    async create(options) {
      calls++;
      requests.push({ region: options.region, colors: options.colors, visible: options.visible });
      const lease = ledger.reserve('work', 8 + (options.colors ? 12 : 0) + (options.visible ? 4 : 0));
      let disposed = false;
      const map: SurfaceMap = { width: 1, height: 1, fullWidth: 1, fullHeight: 1, region: options.region, depths: new Float32Array([2]),
        opacities: new Float32Array([.8]), colors: options.colors ? new Float32Array([.5, .5, .5]) : undefined,
        visible: options.visible ? new Uint32Array([1]) : undefined, deviceEpoch: 1, attempts: 1, tileCapacity: 1,
        allocationBytes: lease.bytes, candidateBytes: 4, candidateEntries: 1, tileCount: 1, occupiedTiles: 1, sortComparisons: 0,
        assertCurrent() { if (disposed || stale) throw new Error('Map expired'); },
        dispose() { disposed = true; lease(); } };
      entered.resolve();
      try {
        if (gate) await gate.promise;
        options.signal.throwIfAborted();
        if (refuse) throw new Error('Injected query refusal');
        return map;
      } catch (error) { map.dispose(); throw error; }
    },
    async adopt(data, options) {
      options.current(); adoptions++;
      const payloadBytes = data.depths.byteLength + data.opacities.byteLength + (data.colors?.byteLength ?? 0) + (data.visible?.byteLength ?? 0);
      const lease = options.admit(payloadBytes + 4), mapId = ++nextId; active = mapId;
      let disposed = false;
      return { mapId, payloadBytes, nativeBytes: lease.bytes, summary: {} as NativeSummary,
        assertCurrent() { options.current(); if (disposed || active !== mapId) throw new Error('Native map retired'); },
        async dispose() { if (!disposed) { disposed = true; if (active === mapId) active = 0; lease(); } },
      } as AdoptedSelectionMap;
    },
  };
  return { ledger, cache, source, entered, requests, get calls() { return calls; }, get adoptions() { return adoptions; },
    set stale(value: boolean) { stale = value; }, set refuse(value: boolean) { refuse = value; },
    hold() { gate = deferred(); return gate; } };
}

describe('selection map cache ownership', () => {
  it('reports actual browser/native owners without creating a cache request or claiming hit counters',async()=>{
    const f=fixture(),ids=new WeakMap<object,number>();let sequence=0;
    const identity=(value:object)=>{let id=ids.get(value);if(id===undefined){id=++sequence;ids.set(value,id);}return id;};
    expect(f.cache.diagnosticSnapshot(identity).active).toBeNull();expect(f.calls).toBe(0);
    const first=await f.cache.acquire(f.source),before=f.cache.diagnosticSnapshot(identity);
    expect(before.active).toMatchObject({mapId:first.mapId,current:true});expect(before.counters.available).toBe(false);
    await f.cache.acquire(f.source);expect(f.cache.diagnosticSnapshot(identity).active!.ownerId).toBe(before.active!.ownerId);expect(f.calls).toBe(1);
    await f.cache.acquire(f.source,{colors:true});expect(f.cache.diagnosticSnapshot(identity).active!.ownerId).not.toBe(before.active!.ownerId);
    await f.cache.invalidate();expect(f.cache.diagnosticSnapshot(identity).active).toBeNull();
  });
  it('coalesces matching requests and reuses the admitted owner without another query or transfer', async () => {
    const f = fixture();
    const [first, second] = await Promise.all([f.cache.acquire(f.source), f.cache.acquire(f.source)]);
    expect(first).toBe(second); expect(f.calls).toBe(1); expect(f.adoptions).toBe(1);
    expect(await f.cache.acquire(f.source)).toBe(first); expect(f.calls).toBe(1);
    expect(f.ledger.usage.bytes).toBe(20);
    await f.cache.invalidate(); expect(f.ledger.usage.bytes).toBe(0); expect(() => first.assertCurrent()).toThrow();
  });

  it('keeps the previous usable owner if an optional-channel query is refused', async () => {
    const f = fixture(), first = await f.cache.acquire(f.source);
    f.refuse = true;
    await expect(f.cache.acquire(f.source, { colors: true, visible: true })).rejects.toThrow('query refusal');
    first.assertCurrent(); expect(await f.cache.acquire(f.source)).toBe(first);
    expect(f.adoptions).toBe(1); expect(f.ledger.usage.bytes).toBe(20);
    await f.cache.invalidate(); expect(f.ledger.usage.bytes).toBe(0);
  });

  it('adopts the upgraded channels before retiring the previous CPU/native owner', async () => {
    const f = fixture(), first = await f.cache.acquire(f.source);
    const upgraded = await f.cache.acquire(f.source, { colors: true, visible: true });
    expect(upgraded.map.colors).toHaveLength(3); expect(upgraded.map.visible).toEqual(new Uint32Array([1]));
    expect(() => first.assertCurrent()).toThrow(); upgraded.assertCurrent();
    expect(f.calls).toBe(2); expect(f.adoptions).toBe(2); expect(f.ledger.usage.bytes).toBe(52);
    expect(await f.cache.acquire(f.source, { visible: true })).toBe(upgraded);
    await f.cache.invalidate(); expect(f.ledger.usage.bytes).toBe(0);
  });

  it('releases obsolete in-flight data before it can reach native adoption', async () => {
    const f = fixture(), gate = f.hold();
    const work = f.cache.acquire(f.source).then(() => 'accepted', error => String(error));
    await f.entered.promise; f.stale = true; f.cache.validate(); gate.resolve();
    expect(await work).toMatch(/cancel|expired/i); expect(f.adoptions).toBe(0);
    await f.cache.invalidate(); expect(f.ledger.usage.bytes).toBe(0);
  });

  it('cancelling one waiter leaves a matching query alive for another waiter', async () => {
    const f = fixture(), gate = f.hold(), abort = new AbortController();
    const cancelled = f.cache.acquire(f.source, {}, abort.signal).catch(error => error.name);
    const kept = f.cache.acquire(f.source);
    await f.entered.promise; abort.abort(); expect(await cancelled).toBe('AbortError');
    gate.resolve(); const result = await kept; result.assertCurrent();
    expect(f.calls).toBe(1); expect(f.adoptions).toBe(1);
    await f.cache.invalidate(); expect(f.ledger.usage.bytes).toBe(0);
  });

  it('cancelling the final waiter retires the query and all admitted data', async () => {
    const f = fixture(), gate = f.hold(), abort = new AbortController();
    const work = f.cache.acquire(f.source, {}, abort.signal).catch(error => error.name);
    await f.entered.promise; abort.abort(); expect(await work).toBe('AbortError'); gate.resolve();
    await f.cache.invalidate(); expect(f.adoptions).toBe(0); expect(f.ledger.usage.bytes).toBe(0);
  });

  it('reuses full coverage for partial requests and requires full coverage for a full consumer', async () => {
    const region = { x: 16, y: 16, width: 16, height: 16 };
    const full = fixture(), first = await full.cache.acquire(full.source);
    expect(await full.cache.acquire(full.source, { region })).toBe(first); expect(full.calls).toBe(1);
    await full.cache.invalidate(); expect(full.ledger.usage.bytes).toBe(0);

    const partial = fixture(), local = await partial.cache.acquire(partial.source, { region });
    expect(local.map.region).toEqual(region);
    const complete = await partial.cache.acquire(partial.source);
    expect(complete.map.region).toBeUndefined(); expect(partial.calls).toBe(2);
    expect(() => local.assertCurrent()).toThrow(); complete.assertCurrent();
    await partial.cache.invalidate(); expect(partial.ledger.usage.bytes).toBe(0);
  });

  it('unions growing published coverage while preserving its immutable previous owner', async () => {
    const f = fixture(), initial = { x: 16, y: 16, width: 16, height: 16 };
    const first = await f.cache.acquire(f.source, { region: initial });
    initial.x = 200; expect(first.map.region).toEqual({ x: 16, y: 16, width: 16, height: 16 });
    expect(Object.isFrozen(first.map.region)).toBe(true);
    expect(await f.cache.acquire(f.source, { region: { x: 20, y: 20, width: 4, height: 4 } })).toBe(first);
    const second = await f.cache.acquire(f.source, { region: { x: 48, y: 0, width: 16, height: 16 } });
    expect(second.map.region).toEqual({ x: 16, y: 0, width: 48, height: 32 });
    expect(first.map.region).toEqual({ x: 16, y: 16, width: 16, height: 16 });
    expect(f.calls).toBe(2); expect(f.adoptions).toBe(2);
    await f.cache.invalidate(); expect(f.ledger.usage.bytes).toBe(0);
  });

  it('cancels an insufficient pending region and serializes an immutable union replacement', async () => {
    const f = fixture(), gate = f.hold();
    const first = f.cache.acquire(f.source, { region: { x: 16, y: 16, width: 16, height: 16 } }).catch(error => error.name);
    await f.entered.promise;
    const growing = f.cache.acquire(f.source, { region: { x: 48, y: 0, width: 16, height: 16 } });
    expect(f.requests[0].region).toEqual({ x: 16, y: 16, width: 16, height: 16 });
    gate.resolve(); expect(await first).toBe('AbortError');
    const result = await growing;
    expect(result.map.region).toEqual({ x: 16, y: 0, width: 48, height: 32 });
    expect(f.calls).toBe(2); expect(f.adoptions).toBe(1);
    await f.cache.invalidate(); expect(f.ledger.usage.bytes).toBe(0);
  });

  it('coalesces contained pending regions but cancels a partial pending query for a full consumer', async () => {
    const f = fixture(), gate = f.hold();
    const first = f.cache.acquire(f.source, { region: { x: 16, y: 16, width: 32, height: 32 } }).catch(error => error.name);
    await f.entered.promise;
    const contained = f.cache.acquire(f.source, { region: { x: 20, y: 20, width: 1, height: 1 } }).catch(error => error.name);
    expect(f.calls).toBe(1);
    const full = f.cache.acquire(f.source);
    gate.resolve(); expect(await first).toBe('AbortError'); expect(await contained).toBe('AbortError');
    expect((await full).map.region).toBeUndefined(); expect(f.calls).toBe(2); expect(f.adoptions).toBe(1);
    await f.cache.invalidate(); expect(f.ledger.usage.bytes).toBe(0);
  });

  it('forces Color and global visibility consumers to request complete coverage', async () => {
    for (const channels of [{ colors: true }, { visible: true }]) {
      const f = fixture();
      await f.cache.acquire(f.source, { region: { x: 16, y: 16, width: 16, height: 16 } });
      const upgraded = await f.cache.acquire(f.source, { ...channels, region: { x: 20, y: 20, width: 1, height: 1 } });
      expect(upgraded.map.region).toBeUndefined(); expect(f.requests[1].region).toBeUndefined();
      expect(f.requests[1]).toMatchObject(channels); expect(f.calls).toBe(2);
      await f.cache.invalidate(); expect(f.ledger.usage.bytes).toBe(0);
    }
  });

  it('preserves the previous region if an expanded query is refused', async () => {
    const f = fixture(), region = { x: 16, y: 16, width: 16, height: 16 };
    const first = await f.cache.acquire(f.source, { region }); f.refuse = true;
    await expect(f.cache.acquire(f.source, { region: { x: 48, y: 16, width: 16, height: 16 } })).rejects.toThrow('query refusal');
    first.assertCurrent(); expect(await f.cache.acquire(f.source, { region })).toBe(first);
    expect(f.adoptions).toBe(1); expect(f.ledger.usage.bytes).toBe(20);
    await f.cache.invalidate(); expect(f.ledger.usage.bytes).toBe(0);
  });
});
