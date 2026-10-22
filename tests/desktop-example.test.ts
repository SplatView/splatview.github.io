import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EXAMPLE_SCENE, EXAMPLE_SCENE_LOAD_ERROR, fetchExampleScene, prepareExampleSceneCollection } from '../src/app/exampleScene';
import { AdmissionError, MiB, ResourceLedger, resourceCreditBytes, resourceLeaseCredit, type ResourceLease } from '../src/document/resources';

// Read only the reviewed public leaf. Independent bytes/hash expectations bind
// the loader to the desktop resource rather than a self-generated substitute.
const desktopBytes = new Uint8Array(readFileSync(new URL('../public/examples/bench.sog', import.meta.url)));
const url = new URL('https://splatview.example/project/examples/bench.sog');
function fixture(limit = 64 * MiB) {
  const ledger = new ResourceLedger(limit), abort = new AbortController(), leases: ResourceLease[] = [];
  let current = true;
  const options = { url, signal: abort.signal, admit: (bytes: number) => {
    const lease = ledger.reserve('source', bytes); leases.push(lease); return lease;
  }, current: () => { if (!current) throw new DOMException('Superseded intake', 'AbortError'); } };
  return { options, ledger, abort, leases, supersede: () => { current = false; } };
}
function response(bytes: Uint8Array<ArrayBuffer> = desktopBytes, declared: string | null = String(bytes.byteLength)) {
  return new Response(bytes, { headers: declared === null ? {} : { 'Content-Length': declared } });
}
afterEach(() => vi.restoreAllMocks());

describe('reviewed desktop example', () => {
  it('uses the exact desktop SOG identity and separate authored default camera', () => {
    expect(desktopBytes.byteLength).toBe(5_124_962);
    expect(createHash('sha256').update(desktopBytes).digest('hex'))
      .toBe('a4f0b3d623a10a3d15cf4179c44a54ae88258ef66dbaddbf67009a40b44b1570');
    expect(EXAMPLE_SCENE).toEqual({ name: 'Bench example.sog', path: 'examples/bench.sog', bytes: 5_124_962, splats: 262_556,
      sha256: 'a4f0b3d623a10a3d15cf4179c44a54ae88258ef66dbaddbf67009a40b44b1570',
      view: { target: [2.602029323577881, -0.36847925186157227, -1.6119190454483032],
        yaw: -7.259469985961914, pitch: 0.38079535961151123, distance: 3.7993321418762207,
        fov: 45, yUp: true, roll: 0.21997733414173126, background: 'black' } });
    expect(Object.isFrozen(EXAMPLE_SCENE)).toBe(true); expect(Object.isFrozen(EXAMPLE_SCENE.view)).toBe(true);
    expect(Object.isFrozen(EXAMPLE_SCENE.view.target)).toBe(true);
  });

  it.each([true, false])('verifies and retains the original File with content-length present: %s', async declared => {
    const f = fixture(), fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(desktopBytes, declared ? String(desktopBytes.byteLength) : null));
    const sample = await fetchExampleScene(f.options);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(url, { signal: f.abort.signal, redirect: 'error', credentials: 'same-origin' });
    expect(sample.file.name).toBe('Bench example.sog'); expect(sample.file.size).toBe(5_124_962);
    expect(sample.file.type).toBe('application/octet-stream'); expect(sample.file.lastModified).toBe(0);
    expect(createHash('sha256').update(new Uint8Array(await sample.file.arrayBuffer())).digest('hex')).toBe(EXAMPLE_SCENE.sha256);
    expect(f.ledger.usage.bytes).toBe(5_124_962); expect(f.ledger.usage.allocations).toBe(1);
    sample.dispose(); sample.dispose(); expect(f.ledger.usage.bytes).toBe(0);
  });

  it('accepts a verified response delivered in bounded chunks', async () => {
    let offset = 0;
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new ReadableStream({ pull(controller) {
      if (offset === desktopBytes.byteLength) { controller.close(); return; }
      const end = Math.min(offset + 32 * 1024, desktopBytes.byteLength);
      controller.enqueue(desktopBytes.subarray(offset, end)); offset = end;
    } })));
    const f = fixture(), sample = await fetchExampleScene(f.options);
    expect(sample.file.size).toBe(5_124_962); sample.dispose(); expect(f.ledger.usage.bytes).toBe(0);
  });

  it('verifies decoded bytes when HTTP compression has a different wire length', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(desktopBytes,
      { headers: { 'Content-Encoding': 'gzip', 'Content-Length': '1234' } }));
    const f = fixture(), sample = await fetchExampleScene(f.options);
    expect(sample.file.size).toBe(5_124_962); sample.dispose(); expect(f.ledger.usage.bytes).toBe(0);
  });

  it('refuses network failure and allows an independent retry without retained credit', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('Offline')).mockResolvedValueOnce(response());
    const f = fixture();
    await expect(fetchExampleScene(f.options)).rejects.toThrow(EXAMPLE_SCENE_LOAD_ERROR);
    expect(f.ledger.usage.bytes).toBe(0);
    const sample = await fetchExampleScene(f.options); expect(fetch).toHaveBeenCalledTimes(2);
    sample.dispose(); expect(f.ledger.usage.bytes).toBe(0);
  });

  it.each([404, 503])('refuses HTTP %s and retires its response body', async status => {
    const cancelled = vi.fn();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new ReadableStream({ cancel: cancelled }), { status }));
    const f = fixture(); await expect(fetchExampleScene(f.options)).rejects.toThrow(EXAMPLE_SCENE_LOAD_ERROR);
    expect(cancelled).toHaveBeenCalledOnce(); expect(f.ledger.usage.bytes).toBe(0);
  });

  it.each(['0', '5124961', '5124963', 'unbounded', '5124962.0'])('refuses invalid declared size %s before reading the body', async declared => {
    const cancelled = vi.fn(), pulled = vi.fn();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new ReadableStream({ pull: pulled, cancel: cancelled }, { highWaterMark: 0 }),
      { headers: { 'Content-Length': declared } }));
    const f = fixture(); await expect(fetchExampleScene(f.options)).rejects.toThrow(EXAMPLE_SCENE_LOAD_ERROR);
    expect(pulled).not.toHaveBeenCalled(); expect(cancelled).toHaveBeenCalledOnce(); expect(f.ledger.usage.bytes).toBe(0);
  });

  it('refuses a missing response body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null));
    const f = fixture(); await expect(fetchExampleScene(f.options)).rejects.toThrow(EXAMPLE_SCENE_LOAD_ERROR);
    expect(f.ledger.usage.bytes).toBe(0);
  });

  it.each(['truncated', 'oversized', 'changed'] as const)('refuses a %s body independently of HTTP metadata', async kind => {
    const bytes = kind === 'truncated' ? desktopBytes.slice(0, -1) : kind === 'oversized'
      ? new Uint8Array(EXAMPLE_SCENE.bytes + 1) : new Uint8Array(EXAMPLE_SCENE.bytes);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(bytes, null));
    const f = fixture(); await expect(fetchExampleScene(f.options)).rejects.toThrow(EXAMPLE_SCENE_LOAD_ERROR);
    expect(f.ledger.usage.bytes).toBe(0);
  });

  it('refuses an already cancelled request before admission or fetch', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch'), f = fixture(); f.abort.abort();
    await expect(fetchExampleScene(f.options)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).not.toHaveBeenCalled(); expect(f.leases).toHaveLength(0);
  });

  it('cancels a pending stream read and joins retirement before releasing its credit', async () => {
    let entered!: () => void;
    const reading = new Promise<void>(resolve => { entered = resolve; }), cancelled = vi.fn();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new ReadableStream({
      pull() { entered(); return new Promise<void>(() => undefined); }, cancel: cancelled,
    }, { highWaterMark: 0 })));
    const f = fixture(), pending = fetchExampleScene(f.options);
    await reading; expect(f.ledger.usage.bytes).toBeGreaterThan(EXAMPLE_SCENE.bytes); f.abort.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancelled).toHaveBeenCalledOnce(); expect(f.ledger.usage.bytes).toBe(0);
  });

  it('rejects superseded ownership after a response resolves', async () => {
    let deliver!: (value: Response) => void;
    vi.spyOn(globalThis, 'fetch').mockReturnValue(new Promise<Response>(resolve => { deliver = resolve; }));
    const f = fixture(), pending = fetchExampleScene(f.options); f.supersede(); deliver(response());
    await expect(pending).rejects.toMatchObject({ name: 'AbortError', message: 'Superseded intake' });
    expect(f.ledger.usage.bytes).toBe(0);
  });

  it('preserves admission refusal and performs no unadmitted fetch', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch'), f = fixture(1024);
    await expect(fetchExampleScene(f.options)).rejects.toBeInstanceOf(AdmissionError);
    expect(fetch).not.toHaveBeenCalled(); expect(f.ledger.usage.bytes).toBe(0);
  });
});

describe('existing collection ownership of example bytes', () => {
  it('keeps catalog and File credits separate and releases both through normal collection disposal', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response()), f = fixture();
    const sample = prepareExampleSceneCollection(f.options), catalogCredit = resourceLeaseCredit(f.leases[0]);
    const catalogBytes = resourceCreditBytes(catalogCredit)!;
    expect(fetch).not.toHaveBeenCalled(); expect(f.ledger.usage.bytes).toBe(catalogBytes);
    const [file, same] = await Promise.all([sample.collection.acquireResource(EXAMPLE_SCENE.name, f.options.current),
      sample.collection.acquireResource(EXAMPLE_SCENE.name, f.options.current)]);
    expect(file).toBe(same); expect(fetch).toHaveBeenCalledOnce(); expect(sample.ownsFile(file)).toBe(true);
    expect(sample.ownsFile(new File([desktopBytes], EXAMPLE_SCENE.name))).toBe(false);
    expect(resourceCreditBytes(catalogCredit)).toBe(catalogBytes);
    expect(f.ledger.usage.bytes).toBe(catalogBytes + EXAMPLE_SCENE.bytes); expect(f.ledger.usage.allocations).toBe(2);
    // The collection outlives the intake that acquired it, just like local files.
    f.abort.abort();
    expect(await sample.collection.acquireResource(EXAMPLE_SCENE.name, () => undefined)).toBe(file);
    await sample.collection.dispose(); await sample.collection.dispose();
    expect(sample.ownsFile(file)).toBe(false); expect(resourceCreditBytes(catalogCredit)).toBeUndefined();
    expect(f.ledger.usage.bytes).toBe(0); expect(f.ledger.usage.allocations).toBe(0);
  });

  it('joins a cancelled pending provider before releasing the catalog reservation', async () => {
    let entered!: () => void;
    const reading = new Promise<void>(resolve => { entered = resolve; });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new ReadableStream({
      pull() { entered(); return new Promise<void>(() => undefined); },
    }, { highWaterMark: 0 })));
    const f = fixture(), sample = prepareExampleSceneCollection(f.options);
    const pending = sample.collection.acquireResource(EXAMPLE_SCENE.name, f.options.current);
    const refused = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await reading; const creditBefore = f.ledger.usage.bytes, retired = sample.collection.dispose();
    expect(f.ledger.usage.bytes).toBe(creditBefore);
    f.abort.abort(); await refused; await retired;
    expect(f.ledger.usage.bytes).toBe(0); expect(f.ledger.usage.allocations).toBe(0);
  });
});
