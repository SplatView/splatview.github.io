import { BUILD_DESCRIPTOR } from '../generated/buildIdentity';
import type { ArtifactRole, BuildArtifact, BuildDescriptor } from './contracts';
import type { NativeSource, RuntimeVerificationMode } from './bootstrap';
import { fetchExact, MAX_MANIFEST_BYTES, validateManifest, verifyArtifactBytes, type VerifiedManifest } from './verification';

export interface RuntimeContext {
  mode: RuntimeVerificationMode;
  descriptor: BuildDescriptor;
  assetBase: string;
  entryUrl: string;
  verified?: VerifiedManifest;
  artifacts: Map<ArtifactRole, { artifact: BuildArtifact; url: string; bytes: ArrayBuffer }>;
}
let runtime: Promise<RuntimeContext> | undefined;
let executingEntry: string | undefined;
let acceptedMode: RuntimeVerificationMode | undefined;
const RETAINED = new Set<ArtifactRole>(['document-worker', 'core-glue', 'core-wasm', 'camera-glue', 'camera-wasm']);
export function getRuntimeVerificationMode() { return acceptedMode; }
async function verifyDeployment(entryUrl: string): Promise<RuntimeContext> {
  const entry = new URL(entryUrl), base = new URL(import.meta.env.BASE_URL, document.baseURI);
  if (entry.origin !== location.origin || base.origin !== location.origin) throw new Error('Invalid SplatView application origin.');
  const manifestUrl = new URL('build-manifest.json', base).href;
  const abort = new AbortController(), timer = setTimeout(() => abort.abort(new Error('Build verification timed out. Reload SplatView.')), 45_000);
  try {
    const manifestBytes = await fetchExact(manifestUrl, abort.signal, MAX_MANIFEST_BYTES);
    const verified = await validateManifest(JSON.parse(new TextDecoder().decode(manifestBytes)), manifestUrl, entry.href, BUILD_DESCRIPTOR);
    const artifacts: RuntimeContext['artifacts'] = new Map();
    // Bound parallel requests and preserve exact executable bytes for all later clients.
    const rows = [...verified.artifacts.values()];
    for (let first = 0; first < rows.length; first += 8) {
      await Promise.all(rows.slice(first, first + 8).map(async ({ artifact, url }) => {
        const bytes = await fetchExact(url, abort.signal, artifact.bytes); await verifyArtifactBytes(bytes, artifact);
        if (RETAINED.has(artifact.role)) artifacts.set(artifact.role, { artifact, url, bytes });
      }));
    }
    acceptedMode = 'production-verified';
    return { mode: acceptedMode, descriptor: BUILD_DESCRIPTOR, assetBase: verified.assetBase, entryUrl, verified, artifacts };
  } finally { clearTimeout(timer); abort.abort(); }
}
/** Called only from the executing application entry. Production has no lazy bypass. */
export async function initializeRuntime(entryUrl: string): Promise<void> {
  if (executingEntry && executingEntry !== entryUrl) throw new Error('SplatView already pinned a different application entry.');
  executingEntry = entryUrl;
  if (!runtime) runtime = import.meta.env.DEV ? developmentRuntime(entryUrl) : verifyDeployment(entryUrl);
  await runtime;
}
async function developmentRuntime(entryUrl: string): Promise<RuntimeContext> {
  // Vite serves an unbundled module graph. This mode verifies native identities,
  // but does not claim production executable-closure integrity.
  acceptedMode = 'development-module-graph';
  return { mode: acceptedMode, descriptor: BUILD_DESCRIPTOR,
    assetBase: new URL(import.meta.env.BASE_URL, document.baseURI).href, entryUrl, artifacts: new Map() };
}
export async function ensureRuntime(): Promise<RuntimeContext> {
  if (!runtime) {
    if (!import.meta.env.DEV) throw new Error('SplatView must verify its build before creating a scene or camera.');
    runtime = developmentRuntime(import.meta.url);
  }
  return runtime;
}
export function runtimeNativeSource(context: RuntimeContext, kind: 'core' | 'camera'): NativeSource | undefined {
  if (context.mode !== 'production-verified') return undefined;
  const glue = context.artifacts.get(`${kind}-glue`), wasm = context.artifacts.get(`${kind}-wasm`);
  if (!glue || !wasm) throw new Error(`The verified ${kind} artifacts are missing.`);
  return { assetBase: new URL('wasm/', context.assetBase).href,
    glue: glue.bytes, wasm: wasm.bytes, glueArtifact: glue.artifact, wasmArtifact: wasm.artifact };
}
