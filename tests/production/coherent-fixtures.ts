import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { Page } from '@playwright/test';
import type { ArtifactRole, BuildDescriptor, RuntimeManifest } from '../../src/build/contracts';

type Receipt = { path: string; bytes: number; sha256: string };
export type FixtureName = 'A' | 'B' | 'C';
export type CoherentFixture = {
  root: string; dist: string; manifest: Receipt; inventory: Receipt[];
  build: BuildDescriptor; deploymentId: string; nativeMode: 'reused' | 'compiled';
  semanticProbe: Receipt & { result: { fillMask: number[] } };
};
export type FixtureSet = {
  schemaVersion: 1; kind: 'genuine-coherent-compatibility-fixture-set'; fixtureSetId: string;
  fixtures: Record<FixtureName, CoherentFixture>;
};
export type LoadedFixture = CoherentFixture & { manifestValue: RuntimeManifest; files: Map<string, Buffer> };
export type LoadedSet = { receiptPath: string; receiptSha256: string; fixtureSetId: string;
  fixtures: Record<FixtureName, LoadedFixture> };
export const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  const encoded = JSON.stringify(value); assert.notEqual(encoded, undefined); return encoded!;
}
function workspacePath(path: string) {
  assert(!isAbsolute(path), `Fixture path must be workspace-relative: ${path}`);
  const absolute = resolve(path), fromRoot = relative(resolve('.'), absolute);
  assert(fromRoot && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot), 'Fixture path escapes workspace');
  return absolute;
}
async function checkedReceipt(receipt: Receipt) {
  const bytes = await readFile(workspacePath(receipt.path));
  assert.equal(bytes.length, receipt.bytes, `Changed fixture receipt: ${receipt.path}`);
  assert.equal(hash(bytes), receipt.sha256, `Changed fixture receipt: ${receipt.path}`); return bytes;
}
export function role(fixture: LoadedFixture, name: ArtifactRole) {
  const rows = fixture.manifestValue.artifacts.filter(row => row.role === name);
  assert.equal(rows.length, 1, `Fixture requires one ${name} role`); return rows[0];
}
async function collectFiles(directory: string, prefix = '', files = new Map<string, Buffer>()) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, item.name), key = `${prefix}${item.name}`;
    assert(!(await lstat(path)).isSymbolicLink(), 'Immutable fixture contains a symlink');
    if (item.isDirectory()) await collectFiles(path, `${key}/`, files);
    else { assert(item.isFile(), 'Immutable fixture contains a non-file'); files.set(key, await readFile(path)); }
  }
  return files;
}
export async function loadFixtureSet(): Promise<LoadedSet> {
  let receiptPath = process.env.SPLATVIEW_COMPAT_FIXTURES ?? '.build/cf/active.json';
  let bytes = await readFile(resolve(receiptPath));
  let value = JSON.parse(bytes.toString('utf8')) as FixtureSet | { schemaVersion: number; receiptPath: string; receiptSha256: string };
  if ('receiptPath' in value) {
    assert.equal(value.schemaVersion, 1); receiptPath = value.receiptPath;
    bytes = await readFile(workspacePath(receiptPath)); assert.equal(hash(bytes), value.receiptSha256, 'Fixture pointer digest differs');
    value = JSON.parse(bytes.toString('utf8')) as FixtureSet;
  }
  const set = value as FixtureSet;
  assert.equal(set.schemaVersion, 1); assert.equal(set.kind, 'genuine-coherent-compatibility-fixture-set');
  const { fixtureSetId, ...payload } = set; assert.equal(hash(canonical(payload)), fixtureSetId, 'Fixture set identity differs');
  const fixtures = {} as Record<FixtureName, LoadedFixture>;
  for (const name of ['A', 'B', 'C'] as const) {
    const item = set.fixtures[name], manifestBytes = await checkedReceipt(item.manifest);
    const manifestValue = JSON.parse(manifestBytes.toString('utf8')) as RuntimeManifest;
    assert.deepEqual(manifestValue.build, item.build); assert.equal(manifestValue.deploymentId, item.deploymentId);
    const { deploymentId, ...manifestPayload } = manifestValue;
    assert.equal(hash(canonical(manifestPayload)), deploymentId, 'Fixture deployment identity differs');
    const files = await collectFiles(workspacePath(item.dist));
    assert.equal(item.inventory.length, files.size, 'Fixture dist closure differs');
    const declared = new Set<string>();
    for (const row of item.inventory) {
      assert(!declared.has(row.path), 'Duplicate fixture inventory path'); declared.add(row.path);
      const content = files.get(row.path); assert(content, `Missing immutable artifact ${row.path}`);
      assert.equal(content.length, row.bytes); assert.equal(hash(content), row.sha256);
    }
    assert(files.get('build-manifest.json')!.equals(manifestBytes), 'Fixture manifest must be the actual emitted file');
    for (const row of manifestValue.artifacts) {
      const content = files.get(row.path); assert(content, `Missing runtime artifact ${row.path}`);
      assert.equal(content.length, row.bytes); assert.equal(hash(content), row.sha256);
    }
    const probe = JSON.parse((await checkedReceipt(item.semanticProbe)).toString('utf8')) as { fillMask: number[] };
    assert.deepEqual(probe.fillMask, item.semanticProbe.result.fillMask);
    assert.deepEqual(probe.fillMask, name === 'B' ? [1, 1, 0] : [1, 0, 0]);
    fixtures[name] = { ...item, manifestValue, files };
    const html = files.get(role(fixtures[name], 'html').path)!.toString('utf8');
    for (const kind of ['application-entry', 'stylesheet'] as const) {
      const row = role(fixtures[name], kind), sri = `sha256-${Buffer.from(row.sha256, 'hex').toString('base64')}`;
      assert(html.includes(`./${row.path}`) && html.includes(sri), 'Emitted entry/style integrity is missing');
    }
  }
  const { A, B, C } = fixtures;
  assert.equal(A.nativeMode, 'reused'); assert.equal(B.nativeMode, 'compiled'); assert.equal(C.nativeMode, 'reused');
  for (const item of [A, B, C]) {
    assert.equal(item.build.native.core.abi, 6); assert.equal(item.build.native.camera.abi, 1);
    assert.equal(item.build.native.core.nativeInputId, item.build.native.camera.nativeInputId);
    assert.equal(item.build.native.camera.capabilities.cameraInput, 1);
  }
  assert.equal(A.build.native.core.capabilities.fillSelection, 1); assert.equal(C.build.native.core.capabilities.fillSelection, 1);
  assert.equal(B.build.native.core.capabilities.fillSelection, 2);
  assert.notEqual(A.build.native.core.nativeInputId, B.build.native.core.nativeInputId);
  assert.deepEqual(A.build.native, C.build.native);
  for (const name of ['core-glue', 'core-wasm', 'camera-glue', 'camera-wasm', 'build-provenance'] as const) {
    const left = role(A, name), right = role(C, name);
    assert.equal(left.bytes, right.bytes); assert.equal(left.sha256, right.sha256);
    assert(A.files.get(left.path)!.equals(C.files.get(right.path)!));
  }
  for (const item of [B, C]) {
    assert.notEqual(A.build.appInputId, item.build.appInputId); assert.notEqual(A.deploymentId, item.deploymentId);
    assert.notEqual(role(A, 'document-worker').sha256, role(item, 'document-worker').sha256);
  }
  assert.notEqual(role(A, 'stylesheet').sha256, role(C, 'stylesheet').sha256);
  return { receiptPath, receiptSha256: hash(bytes), fixtureSetId, fixtures };
}

const mime = (path: string) => path.endsWith('.html') ? 'text/html' : path.endsWith('.js') || path.endsWith('.mjs') ? 'text/javascript'
  : path.endsWith('.wasm') ? 'application/wasm' : path.endsWith('.json') || path.endsWith('.map') ? 'application/json'
    : path.endsWith('.css') ? 'text/css' : path.endsWith('.svg') ? 'image/svg+xml' : path.endsWith('.png') ? 'image/png' : 'application/octet-stream';
/** Serve unchanged compiled files. Only explicitly labeled mixed-role faults reseal a manifest. */
export async function serveFixtures(page: Page, set: LoadedSet, entry: FixtureName, deployment = entry, base = '/') {
  assert(base === '/' || base === '/project/');
  const entryFixture = set.fixtures[entry], entryPaths = new Set([
    role(entryFixture, 'html').path, role(entryFixture, 'application-entry').path, role(entryFixture, 'stylesheet').path,
  ]);
  const state = { deployment, manifest: undefined as RuntimeManifest | undefined,
    overrides: new Map<string, Buffer>(), requests: [] as { path: string; deployment: FixtureName }[], escaped: [] as string[] };
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://127.0.0.1:4173') { await route.continue(); return; }
    if (!url.pathname.startsWith(base) || url.search || url.hash || url.pathname.includes('%')) {
      if (/^\/(assets|wasm|icons)\//.test(url.pathname)) state.escaped.push(url.href);
      await route.fulfill({ status: 404, body: 'Outside fixture base' }); return;
    }
    const path = url.pathname.slice(base.length) || 'index.html';
    state.requests.push({ path, deployment: state.deployment });
    const fixture = set.fixtures[state.deployment];
    const bytes = path === 'build-manifest.json' && state.manifest ? Buffer.from(JSON.stringify(state.manifest))
      : state.overrides.get(path) ?? (entryPaths.has(path) ? entryFixture.files.get(path) : fixture.files.get(path));
    if (!bytes) { await route.fulfill({ status: 404, body: 'No such immutable fixture artifact' }); return; }
    await route.fulfill({ status: 200, contentType: mime(path), headers: { 'cache-control': 'no-store' }, body: bytes });
  });
  return state;
}
export function mixRole(state: Awaited<ReturnType<typeof serveFixtures>>, base: LoadedFixture, other: LoadedFixture,
  kind: 'document-worker' | 'core' | 'camera') {
  const manifest = structuredClone(base.manifestValue);
  const roles: ArtifactRole[] = kind === 'document-worker' ? [kind] : [`${kind}-glue`, `${kind}-wasm`];
  for (const name of roles) {
    const original = manifest.artifacts.find(row => row.role === name)!, replacement = role(other, name);
    const bytes = other.files.get(replacement.path)!;
    original.bytes = bytes.length; original.sha256 = hash(bytes); state.overrides.set(original.path, bytes);
  }
  const { deploymentId: _id, ...payload } = manifest; manifest.deploymentId = hash(canonical(payload)); state.manifest = manifest;
  return manifest;
}

declare global { interface Window { __coherentCameraCalls: { identity: number; malloc: number; inputCreate: number } } }
/** Count calls to actual main-thread camera exports; preserve the real instance and numerical functions. */
export async function observeCameraAllocation(page: Page, fixture: LoadedFixture) {
  const glue = fixture.files.get(role(fixture, 'camera-glue').path)!.toString('utf8');
  const symbol = (name: string) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = glue.match(new RegExp(`Module\\["${escaped}"\\]=wasmExports\\["([^"\\]]+)"\\]`));
    assert(match, `Actual camera glue has no ${name} assignment`); return match[1];
  };
  await page.addInitScript(aliases => {
    const counts = { identity: 0, malloc: 0, inputCreate: 0 }; window.__coherentCameraCalls = counts;
    const NativeInstance = WebAssembly.Instance;
    WebAssembly.Instance = class extends NativeInstance {
      constructor(module: WebAssembly.Module, imports?: WebAssembly.Imports) {
        super(module, imports);
        const original = this.exports;
        if (!Object.values(aliases).every(name => typeof original[name] === 'function')) return;
        const observed = { ...original };
        for (const [label, name] of Object.entries(aliases)) {
          const invoke = original[name] as (...args: number[]) => number;
          observed[name] = (...args: number[]) => { counts[label as keyof typeof counts]++; return invoke(...args); };
        }
        Object.defineProperty(this, 'exports', { value: observed });
      }
    };
  }, { identity: symbol('_sv_camera_build_identity'), malloc: symbol('_malloc'), inputCreate: symbol('_sv_camera_input_create') });
}
