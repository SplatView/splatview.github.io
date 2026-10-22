import { describe, expect, it } from 'vitest';
import { NativeHeapAccounting, NativeHeapSampler, validateNativeHeapSnapshot,
  MAX_NATIVE_HEAP_BYTES, WASM_PAGE_BYTES as P } from '../src/document/nativeMemory';
import { AdmissionError, ResourceLedger } from '../src/document/resources';

describe('native heap measurements', () => {
  it('measures real memory growth with a refreshed view and refuses the detached old view', () => {
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 16 });
    const module = { HEAPU8: new Uint8Array(memory.buffer) }, sampler = new NativeHeapSampler();
    const first = sampler.sample(module);
    expect(first).toEqual({ sequence: 1, heapBytes: P }); expect(Object.isFrozen(first)).toBe(true);
    memory.grow(7);
    expect(() => sampler.sample(module)).toThrow(AdmissionError);
    module.HEAPU8 = new Uint8Array(memory.buffer);
    expect(sampler.sample(module)).toEqual({ sequence: 2, heapBytes: 8 * P });
    expect(sampler.sample(module)).toEqual({ sequence: 3, heapBytes: 8 * P });
    expect(first).toEqual({ sequence: 1, heapBytes: P });
  });
  it('refuses heap subviews and shared buffers without consuming a sequence', () => {
    const sampler = new NativeHeapSampler(), buffer = new ArrayBuffer(2 * P);
    expect(() => sampler.sample({ HEAPU8: new Uint8Array(buffer, P) })).toThrow(AdmissionError);
    expect(() => sampler.sample({ HEAPU8: new Uint8Array(buffer, 0, P) })).toThrow(AdmissionError);
    expect(() => sampler.sample({ HEAPU8: new Uint8Array(new SharedArrayBuffer(P)) as unknown as Uint8Array<ArrayBuffer> })).toThrow(AdmissionError);
    expect(sampler.sample({ HEAPU8: new Uint8Array(buffer) }).sequence).toBe(1);
  });
  it('binds its measurements to one initialized module while allowing that module to refresh its view', () => {
    const sampler = new NativeHeapSampler(), module = { HEAPU8: new Uint8Array(new ArrayBuffer(P)) };
    sampler.sample(module);
    expect(() => sampler.sample({ HEAPU8: new Uint8Array(new ArrayBuffer(2 * P)) })).toThrow(AdmissionError);
    module.HEAPU8 = new Uint8Array(new ArrayBuffer(2 * P));
    expect(sampler.sample(module)).toEqual({ sequence: 2, heapBytes: 2 * P });
  });
  it.each([
    ['null', null], ['array', []], ['missing field', { sequence: 1 }],
    ['extra field', { sequence: 1, heapBytes: P, other: 1 }],
    ['zero sequence', { sequence: 0, heapBytes: P }],
    ['fraction sequence', { sequence: 1.5, heapBytes: P }],
    ['unsafe sequence', { sequence: Number.MAX_SAFE_INTEGER + 1, heapBytes: P }],
    ['zero heap', { sequence: 1, heapBytes: 0 }],
    ['unaligned heap', { sequence: 1, heapBytes: P + 1 }],
    ['nonfinite heap', { sequence: 1, heapBytes: Infinity }],
    ['string heap', { sequence: 1, heapBytes: String(P) }],
    ['compiled maximum exceeded', { sequence: 1, heapBytes: MAX_NATIVE_HEAP_BYTES + P }],
  ])('rejects %s', (_label, value) => {
    expect(() => validateNativeHeapSnapshot(value)).toThrow(AdmissionError);
  });
  it('accepts the compiled maximum, copies values and refuses replay or shrinking heaps', () => {
    const input = { sequence: 9, heapBytes: MAX_NATIVE_HEAP_BYTES };
    const snapshot = validateNativeHeapSnapshot(input);
    input.sequence = 10; input.heapBytes = P;
    expect(snapshot).toEqual({ sequence: 9, heapBytes: MAX_NATIVE_HEAP_BYTES });
    expect(() => validateNativeHeapSnapshot(snapshot, snapshot)).toThrow(AdmissionError);
    expect(() => validateNativeHeapSnapshot(input, snapshot)).toThrow(AdmissionError);
  });
  it('copies each measured scalar once before validating it', () => {
    let sequences = 0, sizes = 0;
    const snapshot = validateNativeHeapSnapshot({ get sequence() { return ++sequences === 1 ? 1 : -1; },
      get heapBytes() { return ++sizes === 1 ? P : 0; } });
    expect(snapshot).toEqual({ sequence: 1, heapBytes: P });
    expect(sequences).toBe(1); expect(sizes).toBe(1);
  });
});

describe('per-client retained native heap accounting', () => {
  it('retains the freed large input heap and subtracts only native portions of mixed leases', () => {
    const memory = new WebAssembly.Memory({ initial: 2, maximum: 64 });
    const sampler = new NativeHeapSampler(), ledger = new ResourceLedger(128 * P);
    const module = { HEAPU8: new Uint8Array(memory.buffer) };
    const remainder = ledger.reserve('source', 2 * P), owner = new NativeHeapAccounting(ledger, remainder);
    owner.observe(sampler.sample(module));
    const source = ledger.reserve('source', 17 * P), scene = ledger.reserve('decoded', 2 * P);
    memory.grow(30);
    module.HEAPU8 = new Uint8Array(memory.buffer);
    owner.reconcile(sampler.sample(module), [
      { lease: source, nextLeaseBytes: source.bytes, nativeBytes: 16 * P },
      { lease: scene, nextLeaseBytes: scene.bytes, nativeBytes: 432 },
    ]);
    expect(owner.state).toMatchObject({ heapBytes: 32 * P, coveredBytes: 16 * P + 432,
      remainderBytes: 16 * P - 432 });
    const prior = ledger.usage;
    owner.releaseCovered(source);
    expect(owner.state).toMatchObject({ heapBytes: 32 * P, coveredBytes: 432, remainderBytes: 32 * P - 432 });
    // The one-page JS/hash allowance ends. The sixteen native input pages do
    // not become budget credit merely because their allocation was freed.
    expect(ledger.usage.bytes).toBe(prior.bytes - P);
    expect(ledger.usage.bytes).toBe(34 * P - 432);
    expect(ledger.usage.peakBytes).toBe(prior.peakBytes);
    expect(source.bytes).toBe(0); expect(ledger.owns(source)).toBe(false);
    owner.retire(); scene(); expect(ledger.usage.bytes).toBe(0);
  });
  it('moves released history and map coverage into the same-client remainder at constant H', () => {
    const ledger = new ResourceLedger(16 * P), remainder = ledger.reserve('source', 0);
    const scene = ledger.reserve('decoded', 2 * P), history = ledger.reserve('history', P), map = ledger.reserve('work', P);
    const owner = new NativeHeapAccounting(ledger, remainder);
    owner.updateCoverage([
      { lease: scene, nextLeaseBytes: 2 * P, nativeBytes: P },
      { lease: history, nextLeaseBytes: P, nativeBytes: P },
      { lease: map, nextLeaseBytes: P, nativeBytes: P },
    ]);
    owner.observe({ sequence: 1, heapBytes: 8 * P }); owner.activate();
    const before = ledger.usage;
    owner.releaseCovered(history); owner.releaseCovered(map);
    expect(owner.state).toMatchObject({ coveredBytes: P, remainderBytes: 7 * P, heapBytes: 8 * P });
    expect(ledger.usage.bytes).toBe(before.bytes); expect(ledger.usage.peakBytes).toBe(before.peakBytes);
    expect(ledger.owns(scene)).toBe(true); expect(scene.bytes).toBe(2 * P);
    owner.retire(); scene(); expect(ledger.usage.bytes).toBe(0);
  });
  it('refuses to classify a future admission peak as actual native heap coverage', () => {
    const ledger = new ResourceLedger(8 * P), remainder = ledger.reserve('source', P), stage = ledger.reserve('source', 4 * P);
    const owner = new NativeHeapAccounting(ledger, remainder);
    owner.observe({ sequence: 1, heapBytes: P });
    const before = ledger.usage;
    expect(() => owner.updateCoverage([{ lease: stage, nextLeaseBytes: 4 * P, nativeBytes: 4 * P }])).toThrow(AdmissionError);
    expect(owner.state.remainderBytes).toBe(P); expect(owner.state.coveredBytes).toBe(0);
    expect(ledger.usage).toEqual(before); owner.retire(); stage();
  });
  it('installs actual growth and newly allocated covered payload together without double admission', () => {
    const ledger = new ResourceLedger(10 * P), remainder = ledger.reserve('source', 2 * P);
    const source = ledger.reserve('source', 5 * P), scene = ledger.reserve('decoded', 2 * P);
    const owner = new NativeHeapAccounting(ledger, remainder);
    owner.observe({ sequence: 1, heapBytes: 2 * P });
    owner.reconcile({ sequence: 2, heapBytes: 8 * P }, [
      { lease: source, nextLeaseBytes: source.bytes, nativeBytes: 4 * P },
      { lease: scene, nextLeaseBytes: scene.bytes, nativeBytes: P },
    ]);
    expect(owner.state).toMatchObject({ heapBytes: 8 * P, coveredBytes: 5 * P, remainderBytes: 3 * P });
    expect(ledger.usage.bytes).toBe(10 * P); expect(ledger.usage.peakBytes).toBe(10 * P);
    owner.releaseCovered(source); expect(ledger.usage.bytes).toBe(9 * P);
    owner.retire(); scene();
  });
  it('refuses candidate growth atomically and requires its immediate retirement', () => {
    const ledger = new ResourceLedger(4 * P), remainder = ledger.reserve('source', P), other = ledger.reserve('render', P);
    const owner = new NativeHeapAccounting(ledger, remainder);
    owner.observe({ sequence: 1, heapBytes: P });
    const before = ledger.usage;
    expect(() => owner.observe({ sequence: 2, heapBytes: 4 * P })).toThrow(AdmissionError);
    expect(ledger.usage).toEqual(before); expect(remainder.bytes).toBe(P);
    expect(owner.state).toMatchObject({ sequence: 1, heapBytes: P, unreconciledHeapBytes: 4 * P });
    expect(() => owner.activate()).toThrow(AdmissionError);
    expect(() => owner.observe({ sequence: 3, heapBytes: P })).toThrow(AdmissionError);
    expect(() => owner.updateCoverage([])).toThrow(AdmissionError);
    owner.retire(); other(); expect(ledger.usage.bytes).toBe(0);
  });
  it('records an active measured overage, blocks new admission and preserves committed owners', () => {
    const ledger = new ResourceLedger(6 * P), remainder = ledger.reserve('source', 2 * P);
    const scene = ledger.reserve('decoded', 2 * P), gpu = ledger.reserve('render', P);
    const owner = new NativeHeapAccounting(ledger, remainder);
    owner.updateCoverage([{ lease: scene, nextLeaseBytes: scene.bytes, nativeBytes: P }]);
    owner.observe({ sequence: 1, heapBytes: 3 * P }); owner.activate();
    const state = owner.observe({ sequence: 2, heapBytes: 6 * P });
    expect(state).toMatchObject({ active: true, heapBytes: 6 * P, remainderBytes: 5 * P,
      ledgerOverageBytes: 2 * P, unreconciledHeapBytes: null });
    expect(ledger.usage.bytes).toBe(8 * P); expect(ledger.owns(scene)).toBe(true);
    expect(() => ledger.reserve('work', 0)).toThrow(AdmissionError);
    expect(() => ledger.reserve('work', P)).toThrow(AdmissionError);
    expect(() => gpu.resize(2 * P)).toThrow(AdmissionError);
    // Native release remains a transfer into retained H, even while overage
    // blocks allocation. The mixed lease's nonnative page really is freed.
    owner.releaseCovered(scene);
    expect(owner.state).toMatchObject({ coveredBytes: 0, remainderBytes: 6 * P, ledgerOverageBytes: P });
    gpu(); expect(ledger.overageBytes).toBe(0);
    expect(() => ledger.reserve('work', 1)).toThrow(AdmissionError);
    owner.retire();
    const next = ledger.reserve('work', P); expect(next.bytes).toBe(P); next();
  });
  it('reduces ordinary reservations during overage without permitting redistribution growth', () => {
    const ledger = new ResourceLedger(4 * P), remainder = ledger.reserve('source', P);
    const oldGpu = ledger.reserve('render', 2 * P), idle = ledger.reserve('work', 0);
    const owner = new NativeHeapAccounting(ledger, remainder);
    owner.observe({ sequence: 1, heapBytes: P }); owner.activate();
    owner.observe({ sequence: 2, heapBytes: 4 * P });
    const before = ledger.usage;
    expect(() => ledger.rebalance([{ lease: oldGpu, bytes: P }, { lease: idle, bytes: P }])).toThrow(AdmissionError);
    expect(ledger.usage).toEqual(before);
    oldGpu.resize(P); expect(ledger.overageBytes).toBe(P);
    oldGpu(); idle(); owner.retire(); expect(ledger.usage.bytes).toBe(0);
  });
  it('keeps active, candidate and retiring heap owners independent', () => {
    const ledger = new ResourceLedger(32 * P);
    const oldR = ledger.reserve('source', 0), newR = ledger.reserve('source', 0);
    const old = new NativeHeapAccounting(ledger, oldR), next = new NativeHeapAccounting(ledger, newR);
    old.observe({ sequence: 1, heapBytes: 4 * P }); old.activate();
    next.observe({ sequence: 1, heapBytes: 8 * P }); next.activate();
    expect(ledger.usage.bytes).toBe(12 * P);
    old.retire(); old.retire();
    expect(ledger.usage.bytes).toBe(8 * P); expect(newR.bytes).toBe(8 * P);
    expect(next.state).toMatchObject({ sequence: 1, active: true, retired: false });
    expect(() => old.observe({ sequence: 2, heapBytes: 8 * P })).toThrow(AdmissionError);
    next.retire(); expect(ledger.usage.bytes).toBe(0);
  });
  it('refuses foreign, retired and duplicate coverage without changing any reservation or registry', () => {
    const ledger = new ResourceLedger(32 * P), foreignLedger = new ResourceLedger(8 * P);
    const remainder = ledger.reserve('source', 0), scene = ledger.reserve('decoded', P);
    const foreign = foreignLedger.reserve('decoded', P), retired = ledger.reserve('work', P); retired();
    const owner = new NativeHeapAccounting(ledger, remainder);
    owner.observe({ sequence: 1, heapBytes: 4 * P });
    const before = ledger.usage, state = owner.state;
    for (const lease of [foreign, retired, remainder])
      expect(() => owner.updateCoverage([{ lease, nextLeaseBytes: P, nativeBytes: P }])).toThrow(AdmissionError);
    expect(() => owner.updateCoverage([
      { lease: scene, nextLeaseBytes: P, nativeBytes: P }, { lease: scene, nextLeaseBytes: P, nativeBytes: 0 },
    ])).toThrow(AdmissionError);
    expect(() => owner.updateCoverage([{ lease: scene, nextLeaseBytes: 1, nativeBytes: 2 }])).toThrow(AdmissionError);
    expect(ledger.usage).toEqual(before); expect(owner.state).toEqual(state); expect(scene.bytes).toBe(P);
    owner.updateCoverage([{ lease: scene, nextLeaseBytes: P, nativeBytes: P }]);
    expect(owner.state.coveredBytes).toBe(P);
    owner.retire(); scene(); foreign();
  });
  it('rejects coverage and remainder leases owned by another client on the same ledger', () => {
    const ledger = new ResourceLedger(16 * P), remainderA = ledger.reserve('source', 0), remainderB = ledger.reserve('source', 0);
    const scene = ledger.reserve('decoded', P), a = new NativeHeapAccounting(ledger, remainderA), b = new NativeHeapAccounting(ledger, remainderB);
    a.updateCoverage([{ lease: scene, nextLeaseBytes: P, nativeBytes: P }]);
    const before = ledger.usage;
    expect(() => b.updateCoverage([{ lease: scene, nextLeaseBytes: P, nativeBytes: P }])).toThrow(AdmissionError);
    expect(() => b.updateCoverage([{ lease: remainderA, nextLeaseBytes: P, nativeBytes: P }])).toThrow(AdmissionError);
    expect(() => new NativeHeapAccounting(ledger, remainderA)).toThrow(AdmissionError);
    expect(ledger.usage).toEqual(before); expect(b.state.coveredBytes).toBe(0);
    a.retire(); b.retire(); scene();
  });
  it('refuses foreign/non-source/dead remainder owners and detects externally released coverage', () => {
    const ledger = new ResourceLedger(8 * P), foreignLedger = new ResourceLedger(8 * P);
    const foreign = foreignLedger.reserve('source', P), render = ledger.reserve('render', P), dead = ledger.reserve('source', P); dead();
    for (const lease of [foreign, render, dead]) expect(() => new NativeHeapAccounting(ledger, lease)).toThrow(AdmissionError);
    const remainder = ledger.reserve('source', 0), scene = ledger.reserve('decoded', P), owner = new NativeHeapAccounting(ledger, remainder);
    owner.updateCoverage([{ lease: scene, nextLeaseBytes: P, nativeBytes: P }]); scene();
    expect(() => owner.observe({ sequence: 1, heapBytes: 2 * P })).toThrow(AdmissionError);
    owner.retire(); render(); foreign();
  });
  it('detects a live remainder changed externally before activation or further coverage work', () => {
    for (const resized of [0, 5 * P]) {
      const ledger = new ResourceLedger(8 * P), remainder = ledger.reserve('source', P);
      const owner = new NativeHeapAccounting(ledger, remainder);
      owner.observe({ sequence: 1, heapBytes: 4 * P }); remainder.resize(resized);
      expect(ledger.owns(remainder)).toBe(true);
      expect(() => owner.activate()).toThrow(AdmissionError);
      expect(() => owner.observe({ sequence: 2, heapBytes: 4 * P })).toThrow(AdmissionError);
      expect(() => owner.updateCoverage([])).toThrow(AdmissionError);
      owner.retire(); expect(ledger.usage.bytes).toBe(0);
    }
  });
  it('cannot overwrite newer heap telemetry through a reentrant snapshot getter', () => {
    const ledger = new ResourceLedger(8 * P), remainder = ledger.reserve('source', 0);
    const owner = new NativeHeapAccounting(ledger, remainder); owner.observe({ sequence: 1, heapBytes: P });
    expect(() => owner.observe({
      get sequence() { owner.observe({ sequence: 3, heapBytes: 4 * P }); return 2; }, heapBytes: 2 * P,
    })).toThrow(AdmissionError);
    expect(owner.state).toMatchObject({ sequence: 3, heapBytes: 4 * P, remainderBytes: 4 * P });
    expect(ledger.usage.bytes).toBe(4 * P); owner.retire();
  });
  it('refuses an unaffordable coverage update without committing its registry or peak', () => {
    const ledger = new ResourceLedger(4 * P), remainder = ledger.reserve('source', 0), scene = ledger.reserve('decoded', P);
    const owner = new NativeHeapAccounting(ledger, remainder); owner.observe({ sequence: 1, heapBytes: 2 * P });
    const before = ledger.usage, state = owner.state;
    expect(() => owner.updateCoverage([{ lease: scene, nextLeaseBytes: 4 * P, nativeBytes: 0 }])).toThrow(AdmissionError);
    expect(ledger.usage).toEqual(before); expect(owner.state).toEqual(state);
    expect(() => owner.releaseCovered(scene)).toThrow(AdmissionError);
    owner.updateCoverage([{ lease: scene, nextLeaseBytes: P, nativeBytes: P }]);
    owner.releaseCovered(scene); owner.retire(); expect(ledger.usage.bytes).toBe(0);
  });
  it('snapshots caller coverage records once before validation and ledger/registry commit', () => {
    const ledger = new ResourceLedger(16 * P), aR = ledger.reserve('source', 0), bR = ledger.reserve('source', 0);
    const a = new NativeHeapAccounting(ledger, aR), b = new NativeHeapAccounting(ledger, bR);
    const sceneA = ledger.reserve('decoded', P), sceneB = ledger.reserve('decoded', P);
    b.updateCoverage([{ lease: sceneB, nextLeaseBytes: P, nativeBytes: P }]);
    let leases = 0, sizes = 0, natives = 0;
    a.updateCoverage([{
      get lease() { return ++leases === 1 ? sceneA : sceneB; },
      get nextLeaseBytes() { return ++sizes === 1 ? P : 2 * P; },
      get nativeBytes() { return ++natives === 1 ? P : 2 * P; },
    }]);
    expect([leases, sizes, natives]).toEqual([1, 1, 1]);
    expect(a.state.coveredBytes).toBe(P); expect(b.state.coveredBytes).toBe(P);
    expect(sceneA.bytes).toBe(P); expect(sceneB.bytes).toBe(P);
    a.releaseCovered(sceneA); b.releaseCovered(sceneB); a.retire(); b.retire();
  });
});

describe('retained native coverage transfers', () => {
  it('redistributes already-covered work into history during active overage at unchanged H', () => {
    const ledger = new ResourceLedger(6 * P), remainder = ledger.reserve('source', 2 * P);
    const scene = ledger.reserve('decoded', 2 * P), work = ledger.reserve('work', P), history = ledger.reserve('history', 0);
    const owner = new NativeHeapAccounting(ledger, remainder);
    owner.updateCoverage([
      { lease: scene, nextLeaseBytes: 2 * P, nativeBytes: P },
      { lease: work, nextLeaseBytes: P, nativeBytes: P },
    ]);
    owner.observe({ sequence: 1, heapBytes: 4 * P }); owner.activate();
    owner.observe({ sequence: 2, heapBytes: 8 * P });
    const before = ledger.usage, state = owner.state;
    expect(state.ledgerOverageBytes).toBe(3 * P);
    expect(() => ledger.rebalance([{ lease: work, bytes: 0 }, { lease: history, bytes: P }])).toThrow(AdmissionError);
    expect(ledger.usage).toEqual(before); expect(work.bytes).toBe(P); expect(history.bytes).toBe(0);
    owner.transferCoverage([
      { lease: work, nextLeaseBytes: 0, nativeBytes: 0 },
      { lease: history, nextLeaseBytes: P, nativeBytes: P },
    ], 2 * P);
    expect(owner.state).toEqual(state); expect(ledger.usage).toEqual(before);
    expect(work.bytes).toBe(0); expect(history.bytes).toBe(P); expect(owner.covers(history)).toBe(true);
    owner.retire(); scene(); work(); history(); expect(ledger.usage.bytes).toBe(0);
  });
  it('moves measured live payload from the remainder into history without adding aggregate admission', () => {
    const ledger = new ResourceLedger(12 * P), remainder = ledger.reserve('source', 0);
    const scene = ledger.reserve('decoded', 2 * P), history = ledger.reserve('history', 0);
    const owner = new NativeHeapAccounting(ledger, remainder);
    owner.updateCoverage([{ lease: scene, nextLeaseBytes: 2 * P, nativeBytes: P }]);
    owner.observe({ sequence: 1, heapBytes: 6 * P }); owner.activate();
    const before = ledger.usage;
    // A fresh native summary measured three live payload pages: one scene
    // page already covered and two history pages currently charged through R.
    owner.transferCoverage([{ lease: history, nextLeaseBytes: 2 * P, nativeBytes: 2 * P }], 3 * P);
    expect(owner.state).toMatchObject({ sequence: 1, heapBytes: 6 * P, coveredBytes: 3 * P, remainderBytes: 3 * P });
    expect(ledger.usage).toEqual(before); expect(before.bytes).toBe(7 * P);
    expect(scene.bytes).toBe(2 * P); expect(history.bytes).toBe(2 * P); expect(owner.covers(history)).toBe(true);
    owner.retire(); scene(); history(); expect(ledger.usage.bytes).toBe(0);
  });
  it('refuses transfer aggregate growth even below the budget without committing coverage or peak', () => {
    const ledger = new ResourceLedger(16 * P), remainder = ledger.reserve('source', 0);
    const scene = ledger.reserve('decoded', 2 * P), history = ledger.reserve('history', 0);
    const owner = new NativeHeapAccounting(ledger, remainder);
    owner.updateCoverage([{ lease: scene, nextLeaseBytes: 2 * P, nativeBytes: P }]);
    owner.observe({ sequence: 1, heapBytes: 4 * P }); owner.activate();
    const before = ledger.usage, state = owner.state;
    // Two lease pages with only one actual native page would add a new JS
    // page; retained native credit cannot admit that extra memory.
    expect(() => owner.transferCoverage([{ lease: history, nextLeaseBytes: 2 * P, nativeBytes: P }], 2 * P)).toThrow(AdmissionError);
    expect(ledger.usage).toEqual(before); expect(owner.state).toEqual(state);
    expect(history.bytes).toBe(0); expect(owner.covers(history)).toBe(false);
    owner.transferCoverage([{ lease: history, nextLeaseBytes: P, nativeBytes: P }], 2 * P);
    expect(ledger.usage).toEqual(before); expect(owner.state.coveredBytes).toBe(2 * P);
    owner.retire(); scene(); history(); expect(ledger.usage.bytes).toBe(0);
  });
  it('refuses future payload coverage beyond the actual maximum even when it fits H', () => {
    const ledger = new ResourceLedger(12 * P), remainder = ledger.reserve('source', 0);
    const scene = ledger.reserve('decoded', P), history = ledger.reserve('history', 0);
    const owner = new NativeHeapAccounting(ledger, remainder);
    owner.updateCoverage([{ lease: scene, nextLeaseBytes: P, nativeBytes: P }]);
    owner.observe({ sequence: 1, heapBytes: 6 * P }); owner.activate();
    const before = ledger.usage, state = owner.state;
    expect(() => owner.transferCoverage([{ lease: history, nextLeaseBytes: 2 * P, nativeBytes: 2 * P }], 2 * P)).toThrow(AdmissionError);
    expect(ledger.usage).toEqual(before); expect(owner.state).toEqual(state);
    expect(history.bytes).toBe(0); expect(owner.covers(history)).toBe(false);
    owner.transferCoverage([{ lease: history, nextLeaseBytes: 2 * P, nativeBytes: 2 * P }], 3 * P);
    expect(ledger.usage).toEqual(before); expect(owner.state.coveredBytes).toBe(3 * P);
    owner.retire(); scene(); history(); expect(ledger.usage.bytes).toBe(0);
  });
  it.each([false, true])('refuses inactive transfer with measured=%s without changing any owner', measured => {
    const ledger = new ResourceLedger(8 * P), remainder = ledger.reserve('source', 0), history = ledger.reserve('history', 0);
    const owner = new NativeHeapAccounting(ledger, remainder);
    if (measured) owner.observe({ sequence: 1, heapBytes: 2 * P });
    const before = ledger.usage, state = owner.state;
    expect(() => owner.transferCoverage([{ lease: history, nextLeaseBytes: P, nativeBytes: P }], P)).toThrow(AdmissionError);
    expect(ledger.usage).toEqual(before); expect(owner.state).toEqual(state);
    expect(history.bytes).toBe(0); expect(owner.covers(history)).toBe(false);
    owner.retire(); history(); expect(ledger.usage.bytes).toBe(0);
  });
  it('refuses foreign, cross-client, dead, remainder and duplicate transfer identities atomically', () => {
    const ledger = new ResourceLedger(32 * P), foreignLedger = new ResourceLedger(4 * P);
    const aR = ledger.reserve('source', 0), bR = ledger.reserve('source', 0);
    const aScene = ledger.reserve('decoded', P), bScene = ledger.reserve('decoded', P);
    const history = ledger.reserve('history', 0), dead = ledger.reserve('history', 0); dead();
    const foreign = foreignLedger.reserve('history', P);
    const a = new NativeHeapAccounting(ledger, aR), b = new NativeHeapAccounting(ledger, bR);
    a.updateCoverage([{ lease: aScene, nextLeaseBytes: P, nativeBytes: P }]);
    b.updateCoverage([{ lease: bScene, nextLeaseBytes: P, nativeBytes: P }]);
    a.observe({ sequence: 1, heapBytes: 4 * P }); b.observe({ sequence: 1, heapBytes: 4 * P }); a.activate(); b.activate();
    const before = ledger.usage, foreignBefore = foreignLedger.usage, aBefore = a.state, bBefore = b.state;
    for (const lease of [foreign, bScene, bR, dead, aR])
      expect(() => a.transferCoverage([{ lease, nextLeaseBytes: P, nativeBytes: P }], 2 * P)).toThrow(AdmissionError);
    expect(() => a.transferCoverage([
      { lease: history, nextLeaseBytes: P, nativeBytes: P },
      { lease: history, nextLeaseBytes: P, nativeBytes: P },
    ], 3 * P)).toThrow(AdmissionError);
    expect(ledger.usage).toEqual(before); expect(foreignLedger.usage).toEqual(foreignBefore);
    expect(a.state).toEqual(aBefore); expect(b.state).toEqual(bBefore); expect(a.covers(history)).toBe(false);
    a.transferCoverage([{ lease: history, nextLeaseBytes: P, nativeBytes: P }], 2 * P);
    expect(ledger.usage).toEqual(before); expect(b.state).toEqual(bBefore);
    a.retire(); b.retire(); aScene(); bScene(); history(); foreign(); expect(ledger.usage.bytes).toBe(0);
  });
});

describe('observed native heap ledger transition', () => {
  it('permits only constant-or-lower aggregate retained transfers during overage and validates all identities first', () => {
    const ledger = new ResourceLedger(3 * P), foreignLedger = new ResourceLedger(4 * P);
    const remainder = ledger.reserve('source', P), work = ledger.reserve('work', P), history = ledger.reserve('history', 0);
    const foreign = foreignLedger.reserve('history', 0), dead = ledger.reserve('history', 0); dead();
    ledger.retainObservedNativeHeap(remainder, 4 * P);
    const before = ledger.usage;
    expect(() => ledger.rebalance([{ lease: work, bytes: 0 }, { lease: history, bytes: P }])).toThrow(AdmissionError);
    for (const lease of [foreign, dead, remainder])
      expect(() => ledger.transferRetainedNativeCoverage(remainder, 4 * P, [{ lease, bytes: 0 }])).toThrow(AdmissionError);
    expect(() => ledger.transferRetainedNativeCoverage(work, P, [])).toThrow(AdmissionError);
    expect(() => ledger.transferRetainedNativeCoverage(remainder, 4 * P, [{ lease: history, bytes: 1 }])).toThrow(AdmissionError);
    expect(ledger.usage).toEqual(before); expect(work.bytes).toBe(P); expect(history.bytes).toBe(0);
    ledger.transferRetainedNativeCoverage(remainder, 4 * P, [{ lease: work, bytes: 0 }, { lease: history, bytes: P }]);
    expect(ledger.usage).toEqual(before); expect(ledger.overageBytes).toBe(2 * P);
    expect(work.bytes).toBe(0); expect(history.bytes).toBe(P);
    ledger.transferRetainedNativeCoverage(remainder, 4 * P, [{ lease: history, bytes: 0 }]);
    expect(ledger.usage.bytes).toBe(4 * P); expect(ledger.usage.peakBytes).toBe(before.peakBytes);
    remainder(); work(); history(); foreign(); expect(ledger.usage.bytes).toBe(0);
  });
  it('validates every reduction before recording an overage and only grows the remainder', () => {
    const ledger = new ResourceLedger(3 * P), remainder = ledger.reserve('source', P), gpu = ledger.reserve('render', P);
    const before = ledger.usage;
    expect(() => ledger.retainObservedNativeHeap(remainder, 4 * P, [{ lease: gpu, bytes: 2 * P }])).toThrow(AdmissionError);
    expect(() => ledger.retainObservedNativeHeap(remainder, 0)).toThrow(AdmissionError);
    expect(() => ledger.retainObservedNativeHeap(gpu, 4 * P)).toThrow(AdmissionError);
    expect(() => ledger.retainObservedNativeHeap(remainder, 4 * P, [{ lease: remainder, bytes: 0 }])).toThrow(AdmissionError);
    expect(ledger.usage).toEqual(before);
    ledger.retainObservedNativeHeap(remainder, 4 * P, [{ lease: gpu, bytes: 0 }]);
    expect(ledger.usage.bytes).toBe(4 * P); expect(ledger.overageBytes).toBe(P);
    expect(ledger.usage.peakBytes).toBe(4 * P); remainder(); gpu();
  });
});
