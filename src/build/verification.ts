import { SINGLETON_ROLES, type ArtifactRole, type BuildArtifact, type BuildDescriptor, type NativeIdentity, type RuntimeManifest } from './contracts';

const HASH = /^[a-f0-9]{64}$/;
export const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
export const MAX_DEPLOYMENT_BYTES = 256 * 1024 * 1024;
export const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const ROLES = new Set<ArtifactRole>([...SINGLETON_ROLES, 'stylesheet', 'runtime-asset']);
const message = (detail: string) => new Error(`SplatView could not verify this build: ${detail} Reload after the site finishes updating.`);
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw message(`invalid ${label}.`);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: readonly string[], label: string) {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw message(`unexpected ${label} field.`);
}
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0; }
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  throw message('invalid canonical data.');
}
export async function sha256(bytes: ArrayBuffer | Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
}
export function parseNativeIdentity(value: unknown): NativeIdentity {
  const data = object(value, 'native identity');
  keys(data, ['schemaVersion', 'kind', 'abi', 'variant', 'nativeInputId', 'mapLayoutVersion', 'capabilities'], 'native identity');
  if (data.schemaVersion !== 1 || !['core', 'camera'].includes(String(data.kind)) || !positive(data.abi) ||
      data.variant !== 'scalar' || typeof data.nativeInputId !== 'string' || !HASH.test(data.nativeInputId)) throw message('invalid native identity.');
  if ((data.kind === 'core' && !positive(data.mapLayoutVersion)) || (data.kind === 'camera' && data.mapLayoutVersion !== undefined))
    throw message('invalid native map layout.');
  const capabilities = object(data.capabilities, 'native capabilities');
  if (!Object.keys(capabilities).length || Object.entries(capabilities).some(([name, revision]) => !/^[a-zA-Z][a-zA-Z0-9]*$/.test(name) || !positive(revision)))
    throw message('invalid native capabilities.');
  return data as unknown as NativeIdentity;
}
export function assertNativeIdentity(actual: unknown, expected: NativeIdentity): NativeIdentity {
  const identity = parseNativeIdentity(actual);
  if (canonicalJson(identity) !== canonicalJson(expected)) throw message(`the ${expected.kind} identity or required capabilities differ.`);
  return identity;
}
export function parseBuildDescriptor(value: unknown): BuildDescriptor {
  const data = object(value, 'application identity');
  keys(data, ['schemaVersion', 'appInputId', 'protocolVersion', 'uiWorkerContract', 'native'], 'application identity');
  if (data.schemaVersion !== 1 || typeof data.appInputId !== 'string' || !HASH.test(data.appInputId) ||
      !positive(data.protocolVersion) || !positive(data.uiWorkerContract)) throw message('invalid application identity.');
  const native = object(data.native, 'native build set'); keys(native, ['core', 'camera'], 'native build set');
  if (parseNativeIdentity(native.core).kind !== 'core' || parseNativeIdentity(native.camera).kind !== 'camera') throw message('swapped native module roles.');
  return data as unknown as BuildDescriptor;
}
export function assertBuildDescriptor(actual: unknown, expected: BuildDescriptor): BuildDescriptor {
  const descriptor = parseBuildDescriptor(actual);
  if (canonicalJson(descriptor) !== canonicalJson(expected)) throw message('the page, worker and native requirements belong to different builds.');
  return descriptor;
}
export interface VerifiedManifest {
  manifest: RuntimeManifest;
  manifestUrl: string;
  assetBase: string;
  artifacts: Map<string, { artifact: BuildArtifact; url: string }>;
}
/** Normalize only simple relative paths. Encoded aliases and dot segments are forbidden. */
export function resolveArtifactPath(path: string, assetBase: string): string {
  if (!path || path.startsWith('/') || !/^[A-Za-z0-9._/-]+$/.test(path) ||
      path.split('/').some(part => !part || part === '.' || part === '..')) throw message('an artifact path escapes the site base.');
  const base = new URL(assetBase);
  if (!/^https?:$/.test(base.protocol) || !base.pathname.endsWith('/') || base.username || base.password || base.search || base.hash)
    throw message('invalid deployment base URL.');
  const url = new URL(path, base);
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname) || url.username || url.password || url.search || url.hash)
    throw message('an artifact URL escapes the site base.');
  return url.href;
}
export async function validateManifest(value: unknown, manifestUrl: string, entryUrl: string, expected: BuildDescriptor): Promise<VerifiedManifest> {
  const data = object(value, 'deployment manifest'); keys(data, ['schemaVersion', 'deploymentId', 'build', 'artifacts'], 'manifest');
  if (data.schemaVersion !== 1 || typeof data.deploymentId !== 'string' || !HASH.test(data.deploymentId) || !Array.isArray(data.artifacts))
    throw message('invalid deployment manifest.');
  if (data.artifacts.length > 4096) throw message('the deployment has too many artifacts.');
  assertBuildDescriptor(data.build, expected);
  const url = new URL(manifestUrl), entry = new URL(entryUrl);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash ||
      !url.pathname.endsWith('/build-manifest.json') || entry.origin !== url.origin || entry.username || entry.password || entry.search || entry.hash)
    throw message('invalid executing entry or manifest URL.');
  const assetBase = new URL('.', url).href;
  const artifacts = new Map<string, { artifact: BuildArtifact; url: string }>();
  const counts = new Map<string, number>();
  let totalBytes = 0;
  for (const candidate of data.artifacts) {
    const artifact = object(candidate, 'artifact'); keys(artifact, ['role', 'path', 'bytes', 'sha256'], 'artifact');
    if (!ROLES.has(artifact.role as ArtifactRole) || typeof artifact.path !== 'string' || !positive(artifact.bytes) ||
        typeof artifact.sha256 !== 'string' || !HASH.test(artifact.sha256)) throw message('invalid artifact record.');
    totalBytes += artifact.bytes;
    if (artifact.bytes > MAX_ARTIFACT_BYTES || totalBytes > MAX_DEPLOYMENT_BYTES) throw message('the deployment exceeds verification memory limits.');
    const resolved = resolveArtifactPath(artifact.path, assetBase);
    if (artifacts.has(resolved)) throw message('duplicate artifact URL.');
    artifacts.set(resolved, { artifact: artifact as unknown as BuildArtifact, url: resolved });
    counts.set(String(artifact.role), (counts.get(String(artifact.role)) ?? 0) + 1);
  }
  for (const role of SINGLETON_ROLES) if (counts.get(role) !== 1) throw message(`missing or ambiguous ${role} role.`);
  const entryArtifact = artifacts.get(entry.href);
  if (entryArtifact?.artifact.role !== 'application-entry') throw message('the executing application entry is not in this deployment.');
  const actualId = await sha256(new TextEncoder().encode(canonicalJson({ schemaVersion: data.schemaVersion, build: data.build, artifacts: data.artifacts })));
  if (actualId !== data.deploymentId) throw message('the deployment identity does not match its manifest.');
  return { manifest: data as unknown as RuntimeManifest, manifestUrl: url.href, assetBase, artifacts };
}
export async function verifyArtifactBytes(bytes: ArrayBuffer, artifact: BuildArtifact): Promise<void> {
  if (bytes.byteLength !== artifact.bytes || await sha256(bytes) !== artifact.sha256) throw message(`the ${artifact.role} bytes differ from this deployment.`);
}
export async function fetchExact(url: string, signal?: AbortSignal, maximumBytes = MAX_ARTIFACT_BYTES): Promise<ArrayBuffer> {
  if (!positive(maximumBytes) || maximumBytes > MAX_ARTIFACT_BYTES) throw message('invalid fetch byte limit.');
  const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin', redirect: 'error', signal });
  if (!response.ok || response.redirected || response.url !== url) throw message(`could not read ${new URL(url).pathname}.`);
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximumBytes)) {
    await response.body?.cancel(); throw message('the artifact exceeds its declared byte limit.');
  }
  if (!response.body) throw message('the artifact has no readable bytes.');
  const reader = response.body.getReader(), chunks: Uint8Array<ArrayBuffer>[] = [];
  let length = 0;
  try {
    while (true) {
      signal?.throwIfAborted(); const result = await reader.read(); if (result.done) break;
      length += result.value.byteLength;
      if (length > maximumBytes) throw message('the artifact exceeds its declared byte limit.');
      chunks.push(result.value);
    }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes.buffer;
  } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
  finally { reader.releaseLock(); }
}
