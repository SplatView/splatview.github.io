import type { NativeSource } from './bootstrap';
import type { NativeIdentity } from './contracts';
import { assertNativeIdentity, verifyArtifactBytes } from './verification';

type IdentityModule = {
  UTF8ToString(pointer: number): string;
  _sv_build_identity?(): number;
  _sv_camera_build_identity?(): number;
};
export function nativeModuleIdentity(module: IdentityModule, expected: NativeIdentity): NativeIdentity {
  const identity = expected.kind === 'core' ? module._sv_build_identity : module._sv_camera_build_identity;
  if (typeof identity !== 'function' || typeof module.UTF8ToString !== 'function')
    throw new Error(`The ${expected.kind} module has no build identity. Reload SplatView after the site finishes updating.`);
  const pointer = identity.call(module);
  if (!Number.isSafeInteger(pointer) || pointer <= 0) throw new Error(`Invalid ${expected.kind} build identity.`);
  let parsed: unknown;
  try { parsed = JSON.parse(module.UTF8ToString(pointer)); }
  catch { throw new Error(`Unreadable ${expected.kind} build identity.`); }
  return assertNativeIdentity(parsed, expected);
}
/** The emitted Emscripten factory ignores wasmBinary. This hook is synchronous. */
export function verifiedInstantiation(compiled: WebAssembly.Module) {
  return (imports: WebAssembly.Imports, receive: (instance: WebAssembly.Instance) => void) => {
    const instance = new WebAssembly.Instance(compiled, imports);
    receive(instance);
    return instance.exports;
  };
}
export function boundedInitialization<T>(operation: Promise<T>, signal?: AbortSignal, timeoutMs = 45_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => { settled = true; clearTimeout(timer); signal?.removeEventListener('abort', aborted); };
    const failed = (reason: unknown) => { if (!settled) { cleanup(); reject(reason); } };
    const aborted = () => failed(signal?.reason instanceof Error ? signal.reason : new DOMException('Initialization cancelled', 'AbortError'));
    const timer = setTimeout(() => failed(new Error('The native module could not initialize in time. Reload SplatView.')), timeoutMs);
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) aborted();
    void operation.then(value => { if (!settled) { cleanup(); resolve(value); } }, failed);
  });
}
export async function instantiateVerifiedModule<T>(source: NativeSource, signal?: AbortSignal, timeoutMs = 45_000): Promise<T> {
  const lifetime = new AbortController();
  const abort = () => lifetime.abort(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  let glueUrl: string | undefined;
  try {
    const operation = (async () => {
      lifetime.signal.throwIfAborted();
      if (source.glueArtifact) await verifyArtifactBytes(source.glue, source.glueArtifact);
      if (source.wasmArtifact) await verifyArtifactBytes(source.wasm, source.wasmArtifact);
      lifetime.signal.throwIfAborted();
      const compiled = await WebAssembly.compile(source.wasm); lifetime.signal.throwIfAborted();
      glueUrl = URL.createObjectURL(new Blob([source.glue], { type: 'text/javascript' }));
      const imported = await import(/* @vite-ignore */ glueUrl) as { default: (options: Record<string, unknown>) => Promise<T> };
      lifetime.signal.throwIfAborted();
      if (typeof imported.default !== 'function') throw new Error('The native module has no factory.');
      // No URL-based binary fallback is allowed. Hook failures reject readiness;
      // the outer bound also handles emitted factories which swallow the throw.
      const value = await imported.default({ instantiateWasm: verifiedInstantiation(compiled),
        locateFile: (path: string) => new URL(path, source.assetBase).href });
      lifetime.signal.throwIfAborted(); return value;
    })();
    return await boundedInitialization(operation, lifetime.signal, timeoutMs);
  } finally {
    lifetime.abort(); signal?.removeEventListener('abort', abort);
    if (glueUrl) URL.revokeObjectURL(glueUrl);
  }
}
