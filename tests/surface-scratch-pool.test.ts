import { describe, expect, it, vi } from 'vitest';
import { AdmissionError, ResourceLedger } from '../src/document/resources';
import { SurfaceScratchPool } from '../src/renderer/webgpu/surfaceScratchPool';

type FakeBuffer = GPUBuffer & { mapState: GPUBufferMapState; destroy: ReturnType<typeof vi.fn> };
function scratchFixture(maximumIdleBytes = 1024, maximumIdleBuffers = 32, limit = 4096) {
  const buffers: FakeBuffer[] = [], ledger = new ResourceLedger(limit);
  let failCreation = false;
  const device = {
    limits: { maxBufferSize: 1024 },
    createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
      if (failCreation) throw new Error('Injected buffer creation failure.');
      const buffer = { ...descriptor, mapState: 'unmapped', destroy: vi.fn() } as unknown as FakeBuffer;
      buffers.push(buffer); return buffer;
    }),
  } as unknown as GPUDevice;
  const pool = new SurfaceScratchPool(device, maximumIdleBytes, maximumIdleBuffers);
  const admit = vi.fn((bytes: number) => ledger.reserve('work', bytes));
  const owner = {};
  const acquire = (size = 64, usage = 1, scope = owner) => pool.acquire(scope, 'Test scratch', size, usage, admit);
  return { device, pool, ledger, admit, buffers, owner, acquire, failCreation: () => { failCreation = true; } };
}

describe('admitted surface scratch reuse', () => {
  it('reuses an idle buffer without duplicating its retained memory credit', () => {
    const f = scratchFixture(), first = f.acquire();
    expect(f.ledger.usage.bytes).toBe(64); expect(first.reused).toBe(false);
    first.release();
    expect(f.pool.snapshot).toMatchObject({ allocatedBytes: 64, idleBytes: 64, idleBuffers: 1, activeBuffers: 0 });
    const second = f.acquire(); expect(second.reused).toBe(true); expect(second.buffer).toBe(first.buffer);
    expect(f.device.createBuffer).toHaveBeenCalledOnce(); expect(f.admit).toHaveBeenCalledOnce();
    expect(f.pool.snapshot).toMatchObject({ idleBytes: 0, activeBuffers: 1, reusedBuffers: 1 });
    second.release(); second.release(); f.pool.dispose();
    expect(f.ledger.usage.bytes).toBe(0); expect(f.buffers[0].destroy).toHaveBeenCalledOnce();
  });
  it('requires matching owner, physical size and usage', () => {
    const f = scratchFixture(); f.acquire().release();
    const anotherOwner = f.acquire(64, 1, {}); anotherOwner.release();
    const anotherSize = f.acquire(32); anotherSize.release();
    const anotherUsage = f.acquire(64, 2); anotherUsage.release();
    expect(f.buffers).toHaveLength(4); expect(f.ledger.usage.bytes).toBe(224);
    f.pool.dispose(); expect(f.ledger.usage.bytes).toBe(0);
  });
  it('updates a reused buffer label for its new readback or diagnostic role', () => {
    const f = scratchFixture(), first = f.pool.acquire(f.owner, 'Surface capacity readback', 64, 1, f.admit);
    first.release();
    const second = f.pool.acquire(f.owner, 'Surface visibility readback', 64, 1, f.admit);
    expect(second.buffer).toBe(first.buffer); expect(second.buffer.label).toBe('Surface visibility readback');
    expect(second.reused).toBe(true); second.release(); f.pool.dispose();
  });
  it('never reuses active buffers or releases their credit during trim', () => {
    const f = scratchFixture(), first = f.acquire(), second = f.acquire();
    expect(second.buffer).not.toBe(first.buffer); expect(f.ledger.usage.bytes).toBe(128);
    f.pool.trim(); expect(f.ledger.usage.bytes).toBe(128);
    expect(f.buffers.every(buffer => !buffer.destroy.mock.calls.length)).toBe(true);
    first.release(); second.release();
    expect(f.pool.snapshot.allocatedBytes).toBe(0); expect(f.ledger.usage.bytes).toBe(0);
    f.acquire().release(); expect(f.buffers).toHaveLength(3); f.pool.dispose();
  });
  it.each(['mapped', 'pending'] as GPUBufferMapState[])('discards a %s buffer after its caller joins retirement', mapState => {
    const f = scratchFixture(), first = f.acquire(); f.buffers[0].mapState = mapState;
    first.release(); expect(f.ledger.usage.bytes).toBe(0); expect(f.buffers[0].destroy).toHaveBeenCalledOnce();
    const second = f.acquire(); expect(second.reused).toBe(false); second.release(); f.pool.dispose();
  });
  it('bounds retained bytes and evicts the least recently returned idle entry', () => {
    const f = scratchFixture(128);
    f.acquire(64, 1).release(); f.acquire(64, 2).release(); f.acquire(64, 3).release();
    expect(f.pool.snapshot).toMatchObject({ idleBytes: 128, idleBuffers: 2 });
    expect(f.buffers[0].destroy).toHaveBeenCalledOnce(); expect(f.ledger.usage.bytes).toBe(128);
    f.pool.dispose();
  });
  it('also bounds tiny idle entries independently of the byte budget', () => {
    const f = scratchFixture(1024, 2);
    for (let usage = 1; usage <= 8; usage++) f.acquire(4, usage).release();
    expect(f.pool.snapshot).toMatchObject({ idleBytes: 8, idleBuffers: 2 });
    expect(f.buffers.filter(buffer => buffer.destroy.mock.calls.length === 1)).toHaveLength(6);
    f.pool.dispose(); expect(f.ledger.usage.bytes).toBe(0);
  });
  it('evicts idle credit and retries one refused admission before creating a buffer', () => {
    const f = scratchFixture(1024, 32, 128); f.acquire().release();
    const other = f.ledger.reserve('history', 64);
    const admitted = f.acquire(32);
    expect(f.admit).toHaveBeenCalledTimes(3); expect(f.buffers[0].destroy).toHaveBeenCalledOnce();
    expect(f.ledger.usage.bytes).toBe(96); admitted.release(); other(); f.pool.dispose();
    expect(f.ledger.usage.bytes).toBe(0);
  });
  it('does not turn busy allocations into disposable pressure credit', () => {
    const f = scratchFixture(1024, 32, 128), first = f.acquire(96), other = f.ledger.reserve('history', 32);
    expect(() => f.acquire(64)).toThrow(AdmissionError);
    expect(f.admit).toHaveBeenCalledTimes(2); expect(f.device.createBuffer).toHaveBeenCalledOnce();
    expect(f.ledger.usage.bytes).toBe(128); expect(f.buffers[0].destroy).not.toHaveBeenCalled();
    first.release(false); other(); expect(f.ledger.usage.bytes).toBe(0);
  });
  it('retries pressure admission at most once and leaves no uncharged buffer on failure', () => {
    const f = scratchFixture(); f.acquire().release();
    const refuse = vi.fn(() => { throw new AdmissionError('Still over budget.'); });
    expect(() => f.pool.acquire(f.owner, 'Refused', 32, 1, refuse)).toThrow('Still over budget.');
    expect(refuse).toHaveBeenCalledTimes(2); expect(f.buffers).toHaveLength(1);
    expect(f.ledger.usage.bytes).toBe(0); expect(f.pool.snapshot.allocatedBytes).toBe(0);
  });
  it('releases a new reservation when physical buffer creation throws', () => {
    const f = scratchFixture(); f.failCreation();
    expect(() => f.acquire()).toThrow('Injected buffer creation failure.');
    expect(f.ledger.usage.bytes).toBe(0); expect(f.pool.snapshot.allocatedBytes).toBe(0);
  });
  it('trims only the requested owner and rejects allocations after device disposal', () => {
    const f = scratchFixture(), secondOwner = {};
    f.acquire().release(); const active = f.acquire(64, 1, secondOwner);
    f.pool.trim(f.owner); expect(f.ledger.usage.bytes).toBe(64);
    expect(f.buffers[0].destroy).toHaveBeenCalledOnce(); expect(f.buffers[1].destroy).not.toHaveBeenCalled();
    f.pool.dispose(); active.release(); f.pool.dispose();
    expect(f.ledger.usage.bytes).toBe(0); expect(f.buffers[1].destroy).toHaveBeenCalledOnce();
    expect(() => f.acquire()).toThrow(/retired/);
  });
  it.each([-1, 0, 2, 6, 1028, NaN, Infinity])('refuses invalid or over-device physical size %s before admission', size => {
    const f = scratchFixture(); expect(() => f.acquire(size)).toThrow(AdmissionError);
    expect(f.admit).not.toHaveBeenCalled(); expect(f.device.createBuffer).not.toHaveBeenCalled();
  });
});
