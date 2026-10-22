import { afterEach, describe, expect, it, vi } from 'vitest';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { SINGLETON_ROLES, type BuildDescriptor, type RuntimeManifest } from '../src/build/contracts';
import { assertBuildDescriptor, assertNativeIdentity, canonicalJson, parseBuildDescriptor, parseNativeIdentity,
  fetchExact, resolveArtifactPath, sha256, validateManifest, verifyArtifactBytes } from '../src/build/verification';
import { boundedInitialization, nativeModuleIdentity, verifiedInstantiation } from '../src/build/native';
import { CameraController, type CameraModule } from '../src/input/camera';
import type { ModuleFactory } from '../src/workers/wasm';

const expected: BuildDescriptor = {
  schemaVersion: 1, appInputId: 'a'.repeat(64), protocolVersion: 6, uiWorkerContract: 1,
  native: {
    core: { schemaVersion: 1, kind: 'core', abi: 6, variant: 'scalar', nativeInputId: 'b'.repeat(64),
      mapLayoutVersion: 1, capabilities: { selectionMap: 1, connectedColorSelection: 1 } },
    camera: { schemaVersion: 1, kind: 'camera', abi: 1, variant: 'scalar', nativeInputId: 'b'.repeat(64), capabilities: { cameraInput: 1 } },
  },
};
const manifestUrl = 'https://example.test/project/build-manifest.json';
const entryUrl = 'https://example.test/project/assets/app.js';
afterEach(() => vi.unstubAllGlobals());
async function deployment(edit?: (manifest: RuntimeManifest) => void) {
  const value: RuntimeManifest = { schemaVersion: 1, deploymentId: '', build: structuredClone(expected),
    artifacts: SINGLETON_ROLES.map((role, index) => ({ role,
      path: role === 'application-entry' ? 'assets/app.js' : `${index}-${role}.bin`, bytes: 4, sha256: 'c'.repeat(64) })) };
  edit?.(value);
  const { deploymentId: _id, ...payload } = value;
  value.deploymentId = await sha256(new TextEncoder().encode(canonicalJson(payload)));
  return value;
}

describe('compiled application/native requirements and deployment closure', () => {
  it('accepts a coherent project-base manifest and stable canonical key order', async () => {
    expect(canonicalJson({ z: 2, a: { b: 3, a: 1 } })).toBe('{"a":{"a":1,"b":3},"z":2}');
    const result = await validateManifest(await deployment(), manifestUrl, entryUrl, expected);
    expect(result.assetBase).toBe('https://example.test/project/'); expect(result.artifacts.size).toBe(8);
  });
  for (const change of ['appInputId', 'protocolVersion', 'uiWorkerContract', 'nativeInputId', 'semantic'] as const)
    it(`refuses ${change} drift even with a self-consistent deployment hash`, async () => {
      const value = await deployment(manifest => {
        if (change === 'appInputId') manifest.build.appInputId = 'd'.repeat(64);
        else if (change === 'nativeInputId') manifest.build.native.core.nativeInputId = 'd'.repeat(64);
        else if (change === 'semantic') manifest.build.native.core.capabilities.connectedColorSelection = 2;
        else manifest.build[change]++;
      });
      await expect(validateManifest(value, manifestUrl, entryUrl, expected)).rejects.toThrow(/different builds/);
    });
  for (const path of ['../core.wasm', '/core.wasm', 'assets//core.wasm', './core.wasm', 'assets/../core.wasm',
    'https://other.test/core.wasm', 'assets/core.wasm?q=1', 'assets/core.wasm#x', 'assets/%2e%2e/core.wasm', 'assets\\core.wasm'])
    it(`refuses aliased or escaping artifact path ${path}`, () => {
      expect(() => resolveArtifactPath(path, 'https://example.test/project/')).toThrow();
    });
  for (const fault of ['duplicate-url', 'duplicate-role', 'missing-role', 'wrong-entry', 'bad-id', 'extra-field'] as const)
    it(`refuses deployment ${fault}`, async () => {
      const value = await deployment(manifest => {
        if (fault === 'duplicate-url') manifest.artifacts[1].path = manifest.artifacts[0].path;
        if (fault === 'duplicate-role') manifest.artifacts.push({ ...manifest.artifacts[0], path: 'extra.html' });
        if (fault === 'missing-role') manifest.artifacts.pop();
        if (fault === 'wrong-entry') manifest.artifacts[1].path = 'assets/other.js';
        if (fault === 'extra-field') Object.assign(manifest, { ignored: true });
      });
      if (fault === 'bad-id') value.deploymentId = 'f'.repeat(64);
      await expect(validateManifest(value, manifestUrl, entryUrl, expected)).rejects.toThrow();
    });
  it('refuses credentials, queries and foreign executing entries', async () => {
    const manifest = await deployment();
    for (const entry of [entryUrl + '?cache=1', entryUrl + '#x', entryUrl.replace('example.test', 'other.test')])
      await expect(validateManifest(manifest, manifestUrl, entry, expected)).rejects.toThrow();
    await expect(validateManifest(manifest, manifestUrl.replace('https://', 'https://user:pass@'), entryUrl, expected)).rejects.toThrow();
  });
  it('requires exact verified bytes and length', async () => {
    const bytes = new TextEncoder().encode('real bytes').buffer;
    const artifact = { role: 'core-wasm' as const, path: 'wasm/core.wasm', bytes: bytes.byteLength, sha256: await sha256(bytes) };
    await expect(verifyArtifactBytes(bytes, artifact)).resolves.toBeUndefined();
    await expect(verifyArtifactBytes(bytes.slice(1), artifact)).rejects.toThrow(/bytes differ/);
    await expect(verifyArtifactBytes(new TextEncoder().encode('fake bytes').buffer, artifact)).rejects.toThrow(/bytes differ/);
  });
  it('refuses missing capabilities, wrong kinds and malformed scalar identities', () => {
    const changed = structuredClone(expected.native.core); delete changed.capabilities.connectedColorSelection;
    expect(() => assertNativeIdentity(changed, expected.native.core)).toThrow(/capabilities differ/);
    for (const malformed of [{ ...changed, abi: 0 }, { ...changed, mapLayoutVersion: 0 }, { ...changed, variant: 'simd' },
      { ...changed, capabilities: { selectionMap: 1.5 } }, { ...changed, schemaVersion: 2 }, { ...changed, unexpected: true }])
      expect(() => parseNativeIdentity(malformed)).toThrow();
    expect(() => parseBuildDescriptor({ ...expected, native: { core: expected.native.camera, camera: expected.native.core } })).toThrow();
    expect(() => assertBuildDescriptor({ ...expected, uiWorkerContract: 2 }, expected)).toThrow();
  });
});

describe('bounded verification and initialization lifetime', () => {
  it('rejects a stalled factory and observes its later rejection', async () => {
    let rejectLate!: (error: Error) => void;
    const operation = new Promise<void>((_resolve, reject) => { rejectLate = reject; });
    await expect(boundedInitialization(operation, undefined, 5)).rejects.toThrow(/initialize in time/);
    rejectLate(new Error('late factory error')); await Promise.resolve();
  });
  it('settles canceled initialization without waiting for the native factory', async () => {
    const abort = new AbortController(), reason = new Error('candidate superseded');
    const operation = boundedInitialization(new Promise<void>(() => undefined), abort.signal, 1000);
    abort.abort(reason); await expect(operation).rejects.toBe(reason);
    await expect(boundedInitialization(Promise.resolve(1), abort.signal)).rejects.toBe(reason);
  });
  it('rejects a declared oversized response before reading the body', async () => {
    const response = new Response('oversized', { headers: { 'content-length': '1000' } });
    Object.defineProperty(response, 'url', { value: entryUrl });
    vi.stubGlobal('fetch', vi.fn(async () => response));
    await expect(fetchExact(entryUrl, undefined, 4)).rejects.toThrow(/byte limit/);
    expect(response.body!.locked).toBe(false);
  });
  it('bounds undeclared streaming bodies and cancels the reader on overflow', async () => {
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(5)); },
      cancel() { canceled = true; },
    });
    const response = new Response(body); Object.defineProperty(response, 'url', { value: entryUrl });
    vi.stubGlobal('fetch', vi.fn(async () => response));
    await expect(fetchExact(entryUrl, undefined, 4)).rejects.toThrow(/byte limit/);
    expect(canceled).toBe(true); expect(body.locked).toBe(false);
  });
  it('refuses redirect/final URL drift instead of reading fallback bytes', async () => {
    const response = new Response('bytes'); Object.defineProperty(response, 'url', { value: 'https://other.test/app.js' });
    vi.stubGlobal('fetch', vi.fn(async () => response));
    await expect(fetchExact(entryUrl)).rejects.toThrow(/could not read/);
    expect(response.bodyUsed).toBe(false);
  });
});

describe('real pre-handshake modules and allocation boundaries', () => {
  it.each(['boundedSpz3Export', 'boundedSogExport', 'currentViewScope'] as const)('refuses the genuine old core for missing %s at the same ABI and input identity', async capability => {
    const imported = await import(/* @vite-ignore */ pathToFileURL(resolve('tests/fixtures/build-compat/core13-group1/splatview-core.mjs')).href);
    const module = await imported.default();
    const actual = parseNativeIdentity(JSON.parse(module.UTF8ToString(module._sv_build_identity())));
    expect(module._sv_abi_version()).toBe(13); expect(module._sv_scene_ptr()).toBe(0); expect(module._sv_states_ptr()).toBe(0);
    expect(actual.capabilities).not.toHaveProperty(capability);
    expect(nativeModuleIdentity(module, actual)).toEqual(actual);
    const required = { ...actual, capabilities: { ...actual.capabilities, [capability]: 1 } };
    expect({ ...required, capabilities: actual.capabilities }).toEqual(actual);
    expect(() => nativeModuleIdentity(module, required)).toThrow(/the core identity or required capabilities differ/);
    expect(nativeModuleIdentity(module, actual)).toEqual(actual);
    expect(module._sv_scene_ptr()).toBe(0); expect(module._sv_states_ptr()).toBe(0);
  });

  it('refuses genuine ABI6 core identity before opening a document', async () => {
    const imported = await import(/* @vite-ignore */ pathToFileURL(resolve('tests/fixtures/build-compat/legacy-abi6-camera1/splatview-core.mjs')).href);
    const module = await imported.default();
    expect(module._sv_abi_version()).toBe(6); expect(module._sv_scene_ptr()).toBe(0);
    expect(() => nativeModuleIdentity(module, expected.native.core)).toThrow(/no build identity/);
    expect(module._sv_scene_ptr()).toBe(0); expect(module._sv_states_ptr()).toBe(0);
  });
  it('refuses genuine ABI1 camera before malloc or input creation', async () => {
    const imported = await import(/* @vite-ignore */ pathToFileURL(resolve('tests/fixtures/build-compat/legacy-abi6-camera1/splatview-camera.mjs')).href);
    const module: CameraModule = await imported.default();
    let allocations = 0, inputs = 0;
    const malloc = module._malloc, create = module._sv_camera_input_create;
    module._malloc = bytes => { allocations++; return malloc(bytes); };
    module._sv_camera_input_create = () => { inputs++; return create(); };
    const factory: ModuleFactory<CameraModule> = async () => module;
    await expect(CameraController.create(factory)).rejects.toThrow(/out of date/);
    expect(allocations).toBe(0); expect(inputs).toBe(0);
  });
  it('instantiates already compiled bytes with a synchronous receive hook', async () => {
    const compiled = await WebAssembly.compile(new Uint8Array([0,97,115,109,1,0,0,0]));
    let received: WebAssembly.Instance | undefined;
    const exports = verifiedInstantiation(compiled)({}, instance => { received = instance; });
    expect(received).toBeInstanceOf(WebAssembly.Instance); expect(exports).toBe(received!.exports);
    expect(exports).not.toBeInstanceOf(Promise);
  });
});
