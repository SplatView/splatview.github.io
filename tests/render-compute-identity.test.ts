import { afterEach, expect, it, vi } from 'vitest';
import { assertComputeIdentity, type ComputeIdentity } from '../src/renderer/webgl2/computeIdentity';
import { RenderComputeClient } from '../src/renderer/webgl2/computeClient';
import type { ComputeRequest, ComputeResponse } from '../src/renderer/webgl2/computeProtocol';
import { BUILD_DESCRIPTOR } from '../src/generated/buildIdentity';

const standalone: ComputeIdentity = { kind: 'standalone', protocolVersion: 1, sourceId: 'a'.repeat(64) };
const application: ComputeIdentity = { kind: 'application', build: BUILD_DESCRIPTOR };
afterEach(() => vi.useRealTimers());

it('separates host kinds and checks the complete application/native descriptor', () => {
  expect(() => assertComputeIdentity(structuredClone(application), application)).not.toThrow();
  expect(() => assertComputeIdentity(standalone, application)).toThrow('different host');
  expect(() => assertComputeIdentity(application, standalone)).toThrow('different host');
  const oldNative = structuredClone(application);
  if (oldNative.kind === 'application') oldNative.build.native.camera.nativeInputId = 'b'.repeat(64);
  expect(() => assertComputeIdentity(oldNative, application)).toThrow();
});
it.each([
  { ...standalone, sourceId: 'b'.repeat(64) }, { ...standalone, protocolVersion: 2 },
  { ...standalone, sourceId: 'bad' }, { ...standalone, extra: true }, null,
])('rejects a mismatched or malformed standalone identity: %j', identity => {
  expect(() => assertComputeIdentity(identity, standalone)).toThrow();
});

function workerFixture() {
  const sent: ComputeRequest[] = [];
  const worker = { onmessage: undefined as ((event: { data: ComputeResponse }) => void) | undefined,
    onerror: undefined as ((event: { preventDefault(): void; message: string }) => void) | undefined,
    postMessage: (data: ComputeRequest) => sent.push(data), terminate: vi.fn() };
  const reply = (identity: ComputeIdentity) => worker.onmessage!({ data: { id: sent[0].id, ok: true, identity } });
  return { worker, sent, reply, owned: worker as unknown as Worker };
}
it('owns the supplied worker until successful initialization and explicit shutdown', async () => {
  const f = workerFixture(), pending = RenderComputeClient.connect(f.owned, standalone);
  expect(f.sent).toEqual([{ id: 1, action: 'initialize', identity: standalone }]);
  f.reply(standalone); const client = await pending;
  expect(f.worker.terminate).not.toHaveBeenCalled(); client.close(); client.close();
  expect(f.worker.terminate).toHaveBeenCalledTimes(1);
});
it('terminates a mismatched executor before publishing a client', async () => {
  const f = workerFixture(), pending = RenderComputeClient.connect(f.owned, standalone);
  f.reply(application); await expect(pending).rejects.toThrow('different host');
  expect(f.worker.terminate).toHaveBeenCalledTimes(1);
});
it('terminates an executor that cannot finish initialization within the deadline', async () => {
  vi.useFakeTimers(); const f = workerFixture(), pending = RenderComputeClient.connect(f.owned, standalone, 25);
  const rejection = expect(pending).rejects.toThrow('in time');
  await vi.advanceTimersByTimeAsync(25); await rejection;
  expect(f.worker.terminate).toHaveBeenCalledTimes(1);
});
it('terminates initialization after an asynchronous browser worker failure', async () => {
  const f = workerFixture(), pending = RenderComputeClient.connect(f.owned, standalone);
  f.worker.onerror!({ preventDefault() {}, message: 'CSP refused the worker module' });
  await expect(pending).rejects.toThrow('CSP refused');
  expect(f.worker.terminate).toHaveBeenCalledTimes(1);
});
