import path from 'node:path';
import { canonicalJson, collectApplicationInputs, createDeploymentManifest, descriptorFromInputs } from '../web-build.mjs';
import { assertShape } from './schema.ts';
import { uniquePaths, Workspace } from './files.ts';
import type { FileRef, Shipping, SourceCapture } from './types.ts';
import type { BuildDescriptor, RuntimeManifest } from '../../src/build/contracts.ts';

const same = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);
export function sameRecords(a: readonly FileRef[], b: readonly FileRef[]): boolean {
  return same([...a].sort((x, y) => x.path.localeCompare(y.path)), [...b].sort((x, y) => x.path.localeCompare(y.path)));
}
const NATIVE = ['splatview-core.mjs', 'splatview-core.wasm', 'splatview-camera.mjs', 'splatview-camera.wasm', 'build-provenance.json'];
export async function inspectShipping(workspace: Workspace, input: Shipping): Promise<{ descriptor: BuildDescriptor; manifest: RuntimeManifest; source: SourceCapture }> {
  for (const key of ['applicationInputs', 'nativeFiles', 'distribution'] as const) { uniquePaths(input[key], `shipping ${key}`); for (const row of input[key]) await workspace.read(row.path, row); }
  const capture = await workspace.json(input.sourceCapture); assertShape<SourceCapture>('SourceCapture', capture);
  for (const key of ['applicationInputs', 'nativeFiles', 'distribution'] as const) if (!sameRecords(capture[key], input[key])) throw new Error(`Source capture ${key} differs from shipping request`);
  uniquePaths(capture.coveredInputs, 'captured covered inputs');
  for (const row of capture.coveredInputs) await workspace.read(row.path, row);
  if (input.nativeFiles.length !== 5 || !same(input.nativeFiles.map(row => row.path).sort(), NATIVE.map(name => 'public/wasm/' + name).sort())) throw new Error('Native identity must name exactly five publication leaves');
  // Audit tree safety BEFORE invoking the existing synchronous collector. Never walk public/wasm.
  await workspace.inventory('src'); await workspace.inventory('public', true);
  const roots = ['index.html', 'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', 'tools/web-build.mjs', 'tools/web-build.d.mts', 'tools/public-assets.json', 'native/wasm/runtime-contract.json'];
  for (const name of roots) await workspace.safe(name);
  const actualInputs = collectApplicationInputs(workspace.root);
  if (!sameRecords(input.applicationInputs, actualInputs)) throw new Error('Current complete application input inventory differs');
  const contractRef = input.applicationInputs.find(row => row.path === 'native/wasm/runtime-contract.json');
  const provenanceRef = input.nativeFiles.find(row => row.path === 'public/wasm/build-provenance.json');
  if (!contractRef || !provenanceRef) throw new Error('Missing native runtime contract/provenance');
  const contract = await workspace.json(contractRef); const provenance = await workspace.json(provenanceRef) as { outputs?: Record<string, { bytes: number; sha256: string }> };
  if (!provenance || typeof provenance !== 'object' || !provenance.outputs || Object.keys(provenance.outputs).sort().join('|') !== NATIVE.filter(name => !name.endsWith('.json')).sort().join('|')) throw new Error('Native provenance output inventory differs');
  for (const row of input.nativeFiles.filter(row => !row.path.endsWith('.json'))) {
    if (!same(provenance.outputs[path.posix.basename(row.path)], { bytes: row.bytes, sha256: row.sha256 })) throw new Error('Native provenance output bytes differ');
  }
  const descriptor = descriptorFromInputs(actualInputs, contract, provenance);
  const generated = await workspace.read('src/generated/buildIdentity.ts');
  const generatedText = new TextDecoder('utf-8', { fatal: true }).decode(generated.bytes);
  const generatedMatch = /export const BUILD_DESCRIPTOR: BuildDescriptor = (\{[\s\S]*\});\s*$/u.exec(generatedText);
  if (!generatedMatch || !same(JSON.parse(generatedMatch[1]!), descriptor) || !capture.coveredInputs.some(row => same(row, generated.reference))) throw new Error('Generated bootstrap descriptor differs or is absent from frozen coverage');
  const manifest = await workspace.json(input.manifest) as RuntimeManifest;
  if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.artifacts) || !same(manifest.build, descriptor)) throw new Error('Deployment build descriptor differs from current inputs');
  if (input.manifest.path !== 'dist/build-manifest.json') throw new Error('Shipping manifest must be final dist/build-manifest.json');
  const actualDist = await workspace.inventory('dist');
  if (!sameRecords(actualDist, input.distribution)) throw new Error('Complete distribution inventory differs (including maps/manifest)');
  for (const source of actualInputs.filter(row => row.path.startsWith('public/'))) {
    const deployed = actualDist.find(row => row.path === 'dist/' + source.path.slice('public/'.length));
    if (!deployed || deployed.bytes !== source.bytes || deployed.sha256 !== source.sha256) throw new Error('Reviewed public source differs from shipped copy: ' + source.path);
  }
  const roles = new Set(['html', 'application-entry', 'document-worker', 'core-glue', 'core-wasm', 'camera-glue', 'camera-wasm', 'build-provenance', 'stylesheet', 'runtime-asset']);
  const artifacts: FileRef[] = [];
  for (const artifact of manifest.artifacts) {
    if (!artifact || typeof artifact !== 'object' || !roles.has(artifact.role) || Object.keys(artifact).sort().join('|') !== 'bytes|path|role|sha256') throw new Error('Malformed/unknown runtime artifact role');
    const reference = { path: 'dist/' + artifact.path, bytes: artifact.bytes, sha256: artifact.sha256 };
    await workspace.read(reference.path, reference); artifacts.push(reference);
  }
  uniquePaths(artifacts, 'runtime artifact');
  const entry = manifest.artifacts.find(row => row.role === 'application-entry'), worker = manifest.artifacts.find(row => row.role === 'document-worker');
  if (!entry || !worker) throw new Error('Runtime entry/worker missing');
  const recreated = createDeploymentManifest(descriptor, manifest.artifacts.map(({ path: name, bytes, sha256 }) => ({ path: name, bytes, sha256 })), entry.path, worker.path);
  if (!same(recreated, manifest)) throw new Error('Deployment digest/roles differ from web-build contract');
  const extras = actualDist.filter(row => !artifacts.some(artifact => artifact.path === row.path));
  const maps = extras.filter(row => row.path.endsWith('.map'));
  if (extras.length !== maps.length + 1 || !extras.some(row => same(row, input.manifest)) || maps.length !== 3) throw new Error('Distribution must contain runtime artifacts plus manifest and exactly three source maps');
  for (const row of maps) {
    const compiled = actualDist.find(item => item.path === row.path.slice(0, -4));
    const mapping = await workspace.json(row) as { version?: number; file?: string };
    if (!compiled || mapping.version !== 3 || mapping.file !== path.posix.basename(compiled.path)) throw new Error('Source map has wrong emitted sibling');
    const bytes = (await workspace.read(compiled.path, compiled)).bytes;
    if (!new TextDecoder().decode(bytes).includes('sourceMappingURL=' + path.posix.basename(row.path))) throw new Error('Emitted sourceMappingURL differs');
  }
  for (const row of input.nativeFiles) {
    const shipped = actualDist.find(item => item.path === 'dist/wasm/' + path.posix.basename(row.path));
    if (!shipped || shipped.bytes !== row.bytes || shipped.sha256 !== row.sha256) throw new Error('Shipped native bytes differ');
  }
  if (capture.appInputId !== descriptor.appInputId || capture.deploymentId !== manifest.deploymentId) throw new Error('Source capture build identity differs');
  // Re-read after synchronous collector and every descriptor/directory check to detect changes.
  for (const row of [...input.applicationInputs, ...input.nativeFiles, ...input.distribution]) await workspace.read(row.path, row);
  return { descriptor, manifest, source: capture };
}
