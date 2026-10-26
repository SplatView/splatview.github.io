import { expect, it, vi } from 'vitest';
import { RenderComputeClient } from '../src/renderer/webgl2/computeClient';
import type { ComputeRequest, ComputeResponse } from '../src/renderer/webgl2/computeProtocol';
import { createRadixScratch, stableDepthOrder } from '../src/renderer/webgl2/radix';
import { planSortScratch } from '../src/renderer/webgl2/sortScratchLayout';
import { GlRenderer, type GlFrame } from '../src/renderer/webgl2/renderer';
import type { GlScene } from '../src/renderer/webgl2/scene';

function fixture() {
  const messages: ComputeRequest[] = [];
  const worker = { onmessage: undefined as ((event: {data: ComputeResponse}) => void) | undefined,
    postMessage: (value: ComputeRequest) => messages.push(value), terminate: vi.fn() };
  const Client = RenderComputeClient as unknown as new (worker: Worker) => RenderComputeClient;
  const client = new Client(worker as unknown as Worker), released = vi.fn(), admit = vi.fn(() => released);
  const acknowledge = (scratchBytes: number) => {
    const message = messages.at(-1)!; worker.onmessage!({ data: { id: message.id, ok: true, scratchBytes } });
  };
  return { client, worker, messages, released, admit, acknowledge };
}
it('admits the large retained histogram through the shared plan and refuses pools above the cap', async () => {
  const f=fixture(), plan=planSortScratch(1_000_000), pending=f.client.acquireSortScratch(1_000_000,f.admit);
  expect(f.admit).toHaveBeenCalledWith(plan.bytes); f.acknowledge(plan.bytes);
  const release=(await pending)!; expect(f.client.sortScratchSnapshot.bytes).toBe(plan.bytes);
  release(); f.client.close(); expect(f.released).toHaveBeenCalledTimes(1);
  const large=fixture(); expect(await large.client.acquireSortScratch(1_376_257,large.admit)).toBeUndefined();
  expect(large.messages).toHaveLength(0); expect(large.admit).not.toHaveBeenCalled(); large.client.close();
});
it('retains a separately leased pool and waits for the last user and worker retirement acknowledgement', async () => {
  const f = fixture(), pending = f.client.acquireSortScratch(100, f.admit);
  f.acknowledge(2224); const first = (await pending)!;
  const second = (await f.client.acquireSortScratch(100, f.admit))!;
  expect(f.admit).toHaveBeenCalledTimes(1); expect(f.admit).toHaveBeenCalledWith(2224);
  await f.client.trimSortScratch(); first(); first();
  expect(f.messages).toHaveLength(1); expect(f.released).not.toHaveBeenCalled();
  second(); await Promise.resolve(); await Promise.resolve();
  expect(f.messages.at(-1)).toMatchObject({ action: 'sortScratch', count: 0 });
  let acquired=false; const waiting=f.client.acquireSortScratch(100,f.admit).then(value=>{acquired=true;return value;});
  await Promise.resolve(); expect(acquired).toBe(false);
  expect(f.released).not.toHaveBeenCalled();
  f.acknowledge(0); expect(await waiting).toBeUndefined(); expect(f.released).toHaveBeenCalledTimes(1);
  f.client.close(); expect(f.released).toHaveBeenCalledTimes(1);
});
it('falls back on refused optional scratch and retires pending allocation on worker termination', async () => {
  const f = fixture();
  expect(await f.client.acquireSortScratch(100, () => { throw new Error('pressure'); })).toBeUndefined();
  expect(f.messages).toHaveLength(0);
  const pending = f.client.acquireSortScratch(100, f.admit); f.client.close();
  expect(await pending).toBeUndefined(); expect(f.released).toHaveBeenCalledTimes(1);
});
it('joins a trim that starts between cache discovery and borrower pinning', async () => {
  const f = fixture(), pending = f.client.acquireSortScratch(100, f.admit);
  f.acknowledge(2224); (await pending)!();
  const trimming = f.client.trimSortScratch(); let resolved = false;
  const acquiring = f.client.acquireSortScratch(100, f.admit).then(value => { resolved = true; return value; });
  for (let i = 0; i < 4; i++) await Promise.resolve();
  expect(f.messages.at(-1)).toMatchObject({ action: 'sortScratch', count: 0 });
  expect(resolved).toBe(false); expect(f.released).not.toHaveBeenCalled();
  f.acknowledge(0); await trimming; expect(await acquiring).toBeUndefined();
  expect(f.released).toHaveBeenCalledTimes(1); f.client.close();
});
it('evicts optional retained scratch and retries the exact baseline admission under pressure', async () => {
  let pinned = true, cacheRetired = false;
  const release = vi.fn(), unpin = vi.fn(() => { pinned = false; });
  const scene = { kind: 'gaussian', id: 1, count: 5, revision: 0, sourceRevision: 1, uploadOrder: vi.fn() } as unknown as GlScene;
  const values = new Float32Array(80), words = new Uint32Array(values.buffer);
  const frame = { scene, revision: 0, values, words, masks: { transform: new Uint8Array(5) } } as GlFrame;
  const admit = vi.fn((bytes: number) => { if (pinned) throw new Error('pressure'); expect(cacheRetired).toBe(true); expect(bytes).toBe(17 * 5 + 320 + 1024); return release; });
  const compute = { acquireSortScratch: async () => unpin,
    trimSortScratch: vi.fn(async () => { expect(pinned).toBe(false); cacheRetired = true; }),
    request: vi.fn(async () => { expect(cacheRetired).toBe(true); return { order: new Uint32Array([1, 4, 0, 2, 3]).buffer }; }) };
  const renderer = Object.assign(Object.create(GlRenderer.prototype), { compute, admitWork: admit, requireScene() {}, retireAfterFence: (done: () => void) => done() }) as GlRenderer;
  await renderer.sortedOrder(frame);
  expect(admit.mock.calls.map(([bytes]) => bytes)).toEqual([5 * 5 + 320, 17 * 5 + 320 + 1024]);
  expect(unpin).toHaveBeenCalledTimes(1); expect(compute.trimSortScratch).toHaveBeenCalledTimes(1);
  expect(scene.uploadOrder).toHaveBeenCalledWith(new Uint32Array([1, 4, 0, 2, 3])); expect(release).toHaveBeenCalledTimes(1);
});
it('never transfers owned radix scratch and returns identical permutations after output detachment', async () => {
  const scratch = createRadixScratch(5), packed = new Float32Array(50), frame = new Float32Array(80); frame[10] = 1;
  [-2, -4, -2, -1, -4].forEach((z, i) => { packed[i * 10 + 2] = z; });
  const first = await stableDepthOrder(packed, 5, 10, frame, new Uint8Array(5), async () => {}, scratch);
  const transferable = first.slice(); structuredClone(transferable.buffer, { transfer: [transferable.buffer] });
  expect(first.buffer.byteLength).toBe(20); expect(transferable.byteLength).toBe(0);
  const next = await stableDepthOrder(packed, 5, 10, frame, new Uint8Array(5), async () => {}, scratch);
  expect(Array.from(next)).toEqual([1, 4, 0, 2, 3]);
  const candidates = new Uint32Array([0, 2, 3]);
  expect(Array.from(await stableDepthOrder(packed, 5, 10, frame, new Uint8Array(5), async () => {}, undefined, candidates))).toEqual([0, 2, 3]);
});
