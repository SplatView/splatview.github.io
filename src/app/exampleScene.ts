import { AdmissionError, bindResourceLeaseCredit, type ResourceLease } from '../document/resources';
import { prepareSceneCollection, type SceneCollectionOptions } from '../io/sceneCollection';
import type { SavedView } from '../io/savedView';

/** Exact desktop tutorial resource; its provenance and notices ship beside it. */
export const EXAMPLE_SCENE = Object.freeze({
  name: 'Bench example.sog', path: 'examples/bench.sog', bytes: 5_124_962, splats: 262_556,
  sha256: 'a4f0b3d623a10a3d15cf4179c44a54ae88258ef66dbaddbf67009a40b44b1570',
  view: Object.freeze({
    target: Object.freeze([2.602029323577881, -0.36847925186157227, -1.6119190454483032] as const),
    yaw: -7.259469985961914, pitch: 0.38079535961151123, distance: 3.7993321418762207,
    fov: 45, yUp: true, roll: 0.21997733414173126, background: 'black',
  } satisfies Omit<SavedView, 'radius'>),
});
export const EXAMPLE_SCENE_LOAD_ERROR = 'The example scene could not be loaded. Try again.';
type ExampleFetchOptions = SceneCollectionOptions & { url: URL; signal: AbortSignal };
type OwnedExampleFile = Readonly<{ file: File; dispose(): void }>;

/** Bound the response before hashing or making a File. Its retained bytes keep
 * their own source credit until the existing collection retires the provider.
 */
export async function fetchExampleScene(options: ExampleFetchOptions): Promise<OwnedExampleFile> {
  const check = () => { options.signal.throwIfAborted(); options.current(); };
  check();
  // Input, digest/File copies and bounded bookkeeping. This shrinks to the
  // immutable File alone once transient verification work has finished.
  const lease = options.admit(EXAMPLE_SCENE.bytes * 3 + 64 * 1024);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined, published = false;
  const abortRead = () => { void reader?.cancel(options.signal.reason).catch(() => undefined); };
  try {
    const response = await fetch(options.url, { signal: options.signal, redirect: 'error', credentials: 'same-origin' });
    reader = response.body?.getReader();
    options.signal.addEventListener('abort', abortRead, { once: true });
    check();
    if (!response.ok || !reader) throw new Error(EXAMPLE_SCENE_LOAD_ERROR);
    const declared = response.headers.get('content-length');
    // Fetch exposes decoded bytes; a compressed response's wire length differs.
    const encoding = response.headers.get('content-encoding');
    if ((!encoding || encoding.toLowerCase() === 'identity') && declared !== null &&
        (!/^\d+$/.test(declared) || Number(declared) !== EXAMPLE_SCENE.bytes))
      throw new Error(EXAMPLE_SCENE_LOAD_ERROR);
    let bytes: Uint8Array<ArrayBuffer> | undefined = new Uint8Array(EXAMPLE_SCENE.bytes), offset = 0;
    for (;;) {
      const { done, value } = await reader.read(); check();
      if (done) break;
      if (value.byteLength > EXAMPLE_SCENE.bytes - offset) throw new Error(EXAMPLE_SCENE_LOAD_ERROR);
      bytes.set(value, offset); offset += value.byteLength;
    }
    if (offset !== EXAMPLE_SCENE.bytes) throw new Error(EXAMPLE_SCENE_LOAD_ERROR);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)); check();
    const hash = Array.from(digest, value => value.toString(16).padStart(2, '0')).join('');
    if (hash !== EXAMPLE_SCENE.sha256) throw new Error(EXAMPLE_SCENE_LOAD_ERROR);
    const file = new File([bytes], EXAMPLE_SCENE.name, { type: 'application/octet-stream', lastModified: 0 });
    bytes = undefined;
    lease.resize(EXAMPLE_SCENE.bytes); check();
    published = true;
    return Object.freeze({ file, dispose: lease });
  } catch (error) {
    check();
    if (error instanceof AdmissionError) throw error;
    throw new Error(EXAMPLE_SCENE_LOAD_ERROR, { cause: error });
  } finally {
    options.signal.removeEventListener('abort', abortRead);
    if (reader) {
      try { await reader.cancel(); } catch { /* A failed or aborted response is already retired. */ }
      reader.releaseLock();
    }
    if (!published) lease();
  }
}

/** One normal collection owns both its catalog and lazily fetched File. The
 * authenticated catalog lease keeps its original size/resize semantics; File
 * bytes have a separate lease, released only after collection disposal joins
 * pending providers. No global cache or independent cancellation owner exists.
 */
export function prepareExampleSceneCollection(options: ExampleFetchOptions) {
  let resource: OwnedExampleFile | undefined, pending: Promise<File> | undefined;
  const collection = prepareSceneCollection([{ path: EXAMPLE_SCENE.name, kind: 'file', getFile: () => {
    if (resource) return Promise.resolve(resource.file);
    if (pending) return pending;
    const task = (async () => {
      const loaded = await fetchExampleScene(options);
      try { options.signal.throwIfAborted(); options.current(); resource = loaded; return loaded.file; }
      catch (error) { loaded.dispose(); throw error; }
    })();
    pending = task;
    const settled = () => { if (pending === task) pending = undefined; };
    void task.then(settled, settled);
    return task;
  } }], { ...options, admit: bytes => {
    const catalog = options.admit(bytes);
    try {
      const retained = (() => {
        try { resource?.dispose(); }
        finally { resource = undefined; catalog(); }
      }) as ResourceLease;
      Object.defineProperties(retained, {
        bytes: { get: () => catalog.bytes }, resize: { value: (next: number) => catalog.resize(next) },
      });
      return bindResourceLeaseCredit(retained, catalog);
    } catch (error) { catalog(); throw error; }
  } });
  return Object.freeze({ collection, ownsFile: (file: File) => resource?.file === file });
}
