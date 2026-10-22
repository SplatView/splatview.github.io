/** Deterministic application identity and post-write deployment inventory. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GENERATED = 'src/generated/buildIdentity.ts';
const MANIFEST = 'build-manifest.json';
const SERVICE_WORKER_PATH = 'service-worker.js';
const PUBLIC_INVENTORY = 'tools/public-assets.json';
const HEX_SHA256 = /^[a-f0-9]{64}$/;
const ROOT_INPUTS = ['index.html', 'package.json', 'package-lock.json', 'tsconfig.json',
  'vite.config.ts', 'tools/web-build.mjs', 'tools/web-build.d.mts', PUBLIC_INVENTORY, 'native/wasm/runtime-contract.json'];
const NATIVE_PATHS = ['wasm/splatview-core.mjs', 'wasm/splatview-core.wasm',
  'wasm/splatview-camera.mjs', 'wasm/splatview-camera.wasm', 'wasm/build-provenance.json'];
const NATIVE_ROLES = {
  'wasm/splatview-core.mjs': 'core-glue', 'wasm/splatview-core.wasm': 'core-wasm',
  'wasm/splatview-camera.mjs': 'camera-glue', 'wasm/splatview-camera.wasm': 'camera-wasm',
  'wasm/build-provenance.json': 'build-provenance',
};
export const SINGLETON_ROLES = ['html', 'application-entry', 'document-worker', 'core-glue',
  'core-wasm', 'camera-glue', 'camera-wasm', 'build-provenance'];

export function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  throw new Error('Build identity requires finite JSON data');
}

export function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function relativeName(root, path) {
  const name = relative(root, path).split(sep).join('/');
  if (!name || name.startsWith('../') || isAbsolute(name)) throw new Error(`Unsafe build path: ${path}`);
  return name;
}

function fileRecord(root, path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Missing or unsafe build input: ${path}`);
  const bytes = readFileSync(path);
  return { path: relativeName(root, path), bytes: bytes.byteLength, sha256: sha256(bytes) };
}

function treeFiles(root, directory, exclude = () => false, qualifyFile = () => {}) {
  const entries = [];
  function visit(path) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`Symlink is not a qualified build input: ${path}`);
    const name = path === root ? '' : relativeName(root, path);
    if (exclude(name)) return;
    if (stat.isDirectory()) {
      for (const child of readdirSync(path).sort()) visit(resolve(path, child));
    } else if (stat.isFile()) { qualifyFile(name); entries.push(fileRecord(root, path)); }
    else throw new Error(`Unsupported build input: ${path}`);
  }
  visit(directory);
  return entries;
}

function reviewedPublicInputs(root) {
  let inventory;
  try { inventory = readJson(resolve(root, PUBLIC_INVENTORY)); }
  catch (cause) { throw new Error('Invalid public asset inventory; review tools/public-assets.json', { cause }); }
  if (!inventory || typeof inventory !== 'object' || Array.isArray(inventory) ||
      Object.keys(inventory).some(key => !['schemaVersion', 'files'].includes(key)) ||
      inventory.schemaVersion !== 1 || !Array.isArray(inventory.files) || inventory.files.length > 4096) {
    throw new Error('Invalid public asset inventory; review tools/public-assets.json');
  }
  const expected = new Set(), aliases = new Set();
  for (const name of inventory.files) {
    assertArtifactPath(name);
    const folded = name.toLowerCase();
    if (folded === 'wasm' || folded.startsWith('wasm/') || folded.endsWith('.map') ||
        aliases.has(folded)) throw new Error(`Invalid or duplicate public asset inventory path: ${name}`);
    expected.add(`public/${name}`); aliases.add(folded);
  }
  // Reject unreviewed leaves before reading their bytes. Native publication is
  // independently qualified from its five exact paths, never a directory walk.
  const records = treeFiles(root, resolve(root, 'public'), name => name === 'public/wasm' || name.startsWith('public/wasm/'), name => {
    if (!expected.has(name)) throw new Error(`Unreviewed public asset: ${name}; remove it or review tools/public-assets.json`);
  });
  const actual = new Set(records.map(record => record.path));
  for (const name of expected) if (!actual.has(name)) throw new Error(`Missing reviewed public asset: ${name}`);
  return records;
}

export function collectApplicationInputs(root = DEFAULT_ROOT) {
  root = resolve(root);
  return [
    ...ROOT_INPUTS.map(name => fileRecord(root, resolve(root, name))),
    ...treeFiles(root, resolve(root, 'src'), name => name === GENERATED),
    ...reviewedPublicInputs(root),
  ].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

function assertRevision(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${label}`);
}

export function descriptorFromInputs(files, contract, provenance) {
  if (contract.schemaVersion !== 1 || provenance.schemaVersion !== 1 || !HEX_SHA256.test(provenance.nativeInputId ?? '')) {
    throw new Error('Native build identity is missing or unsupported; run npm run build:core');
  }
  assertRevision(contract.protocolVersion, 'document protocol revision');
  assertRevision(contract.uiWorkerContract, 'UI/worker contract revision');
  const native = {};
  for (const kind of ['core', 'camera']) {
    const required = contract[kind];
    if (required?.schemaVersion !== 1 || required.kind !== kind || required.variant !== 'scalar' ||
        !required.capabilities || typeof required.capabilities !== 'object' || Array.isArray(required.capabilities)) {
      throw new Error(`Unsupported ${kind} identity contract`);
    }
    assertRevision(required.abi, `${kind} ABI`);
    if (kind === 'core') assertRevision(required.mapLayoutVersion, 'core map layout');
    for (const [name, revision] of Object.entries(required.capabilities)) {
      if (!name) throw new Error(`Invalid ${kind} capability name`);
      assertRevision(revision, `${kind} capability ${name}`);
    }
    native[kind] = { ...required, nativeInputId: provenance.nativeInputId };
    if (canonicalJson(native[kind]) !== canonicalJson(provenance.nativeIdentity?.[kind] ?? null)) {
      throw new Error(`Native ${kind} identity differs from required contract; run npm run build:core`);
    }
  }
  const descriptor = { schemaVersion: 1, protocolVersion: contract.protocolVersion,
    uiWorkerContract: contract.uiWorkerContract, native };
  return { ...descriptor, appInputId: sha256(canonicalJson({ ...descriptor, files })) };
}

function verifyNative(root) {
  execFileSync(process.env.SPLATVIEW_BUILD_PYTHON || 'python',
    [resolve(root, 'tools/verify-toolchain.py'), 'verify-build'],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
}

function readJson(path) { return JSON.parse(readFileSync(path, 'utf8')); }

export function prepareBuild(root = DEFAULT_ROOT) {
  root = resolve(root);
  // Also protects direct `vite` invocation and development startup.
  verifyNative(root);
  const files = collectApplicationInputs(root);
  const descriptor = descriptorFromInputs(files,
    readJson(resolve(root, 'native/wasm/runtime-contract.json')),
    readJson(resolve(root, 'public/wasm/build-provenance.json')));
  const source = `// Generated by tools/web-build.mjs; never edit by hand.\nimport type { BuildDescriptor } from '../build/contracts';\n\nexport const BUILD_DESCRIPTOR: BuildDescriptor = ${JSON.stringify(descriptor, null, 2)};\n`;
  const generated = resolve(root, GENERATED);
  mkdirSync(dirname(generated), { recursive: true });
  let previous;
  try { previous = readFileSync(generated, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous !== source) writeFileSync(generated, source, 'utf8');
  return { root, files, descriptor, generated: fileRecord(root, generated),
    nativeFiles: NATIVE_PATHS.map(name => fileRecord(root, resolve(root, 'public', name))) };
}

export function assertBuildInputsUnchanged(snapshot) {
  if (canonicalJson(collectApplicationInputs(snapshot.root)) !== canonicalJson(snapshot.files) ||
      canonicalJson(fileRecord(snapshot.root, resolve(snapshot.root, GENERATED))) !== canonicalJson(snapshot.generated) ||
      canonicalJson(NATIVE_PATHS.map(name => fileRecord(snapshot.root, resolve(snapshot.root, 'public', name)))) !== canonicalJson(snapshot.nativeFiles)) {
    throw new Error('Application/native inputs changed while bundling; discard this build and rebuild from stable inputs');
  }
  verifyNative(snapshot.root);
}

export function assertArtifactPath(path) {
  if (typeof path !== 'string' || !/^[A-Za-z0-9_./-]+$/.test(path) ||
      path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error(`Unsafe deployment artifact path: ${path}`);
  }
}

export function createDeploymentManifest(build, records, entryPath, workerPath) {
  assertArtifactPath(entryPath);
  assertArtifactPath(workerPath);
  const seen = new Set();
  const artifacts = records.map(record => {
    assertArtifactPath(record.path);
    if (seen.has(record.path)) throw new Error(`Duplicate deployment artifact: ${record.path}`);
    seen.add(record.path);
    if (!Number.isSafeInteger(record.bytes) || record.bytes < 0 || !HEX_SHA256.test(record.sha256)) {
      throw new Error(`Invalid deployment artifact digest: ${record.path}`);
    }
    let role = NATIVE_ROLES[record.path] ?? 'runtime-asset';
    if (record.path === 'index.html') role = 'html';
    else if (record.path === entryPath) role = 'application-entry';
    else if (record.path === workerPath) role = 'document-worker';
    else if (record.path.endsWith('.css')) role = 'stylesheet';
    return { role, path: record.path, bytes: record.bytes, sha256: record.sha256 };
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  for (const role of SINGLETON_ROLES) {
    if (artifacts.filter(artifact => artifact.role === role).length !== 1) {
      throw new Error(`Deployment requires exactly one ${role} artifact`);
    }
  }
  const payload = { schemaVersion: 1, build, artifacts };
  return { ...payload, deploymentId: sha256(canonicalJson(payload)) };
}

export function protectHtml(html, records, entryPath) {
  const byPath = new Map(records.map(record => [record.path, record]));
  function attribute(tag, name) {
    const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(["'])([^"']*)\\1`, 'i'));
    return match?.[2];
  }
  function protect(tag, path) {
    assertArtifactPath(path);
    const record = byPath.get(path);
    if (!record) throw new Error(`HTML references an absent emitted artifact: ${path}`);
    const digest = Buffer.from(record.sha256, 'hex').toString('base64');
    return tag.replace(/\s+(?:integrity|crossorigin)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/gi, '')
      .replace(/\s*\/?\s*>$/, ` integrity="sha256-${digest}" crossorigin="anonymous">`);
  }
  let entries = 0;
  const protectedHtml = html.replace(/<script\b[^>]*>/gi, tag => {
    if (attribute(tag, 'type') !== 'module') return tag;
    const path = attribute(tag, 'src');
    if (path !== `./${entryPath}`) throw new Error('Final HTML does not reference the single qualified application entry');
    entries += 1;
    return protect(tag, entryPath);
  }).replace(/<link\b[^>]*>/gi, tag => {
    if (attribute(tag, 'rel') !== 'stylesheet') return tag;
    const path = attribute(tag, 'href');
    if (!path?.startsWith('./') || !path.endsWith('.css')) throw new Error('Final HTML stylesheet is outside the qualified deployment');
    return protect(tag, path.slice(2));
  });
  if (entries !== 1) throw new Error('Final HTML requires one qualified application entry');
  return protectedHtml;
}

function qualifiedPublicFiles(snapshot) {
  return [...snapshot.files.filter(record => record.path.startsWith('public/')), ...snapshot.nativeFiles];
}

function sameLocation(first, second) {
  const fold = value => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);
  return fold(first) === fold(second);
}

function currentOutputDirectory(snapshot, outDir) {
  outDir = resolve(outDir);
  if (!sameLocation(outDir, resolve(snapshot.root, 'dist'))) throw new Error('Deployment output must be the current workspace dist directory');
  // Check existing ancestors before mkdir/copy, including Windows junctions.
  // A safe final component does not make an aliased parent safe.
  for (let current = outDir;; current = dirname(current)) {
    try {
      const info = lstatSync(current);
      if (!info.isDirectory() || info.isSymbolicLink() || !sameLocation(realpathSync.native(current), current)) {
        throw new Error(`Unsafe deployment output directory: ${current}`);
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (dirname(current) === current) break;
  }
  return outDir;
}

export function copyQualifiedPublic(snapshot, outDir) {
  assertBuildInputsUnchanged(snapshot);
  outDir = currentOutputDirectory(snapshot, outDir);
  mkdirSync(outDir, { recursive: true });
  if (lstatSync(outDir).isSymbolicLink()) throw new Error('Unsafe deployment output directory');
  for (const record of qualifiedPublicFiles(snapshot)) {
    const path = record.path.slice('public/'.length);
    assertArtifactPath(path);
    let directory = outDir;
    for (const part of path.split('/').slice(0, -1)) {
      directory = resolve(directory, part);
      mkdirSync(directory, { recursive: true });
      if (lstatSync(directory).isSymbolicLink()) throw new Error(`Unsafe deployment output directory: ${path}`);
    }
    const target = resolve(outDir, path);
    try {
      if (lstatSync(target).isSymbolicLink()) throw new Error(`Unsafe deployment output file: ${path}`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    // The compiler's directory can contain unpublished temporary files. Only
    // the four provenance-qualified modules and provenance itself are copied.
    copyFileSync(resolve(snapshot.root, record.path), target);
  }
}

export function writeDeploymentManifest(snapshot, outDir, entryPath, workerPath, emittedPaths, serviceWorkerPath) {
  assertBuildInputsUnchanged(snapshot);
  outDir = currentOutputDirectory(snapshot, outDir);
  if (!Array.isArray(emittedPaths) || !emittedPaths.length) throw new Error('Actual emitted bundle paths are required');
  assertArtifactPath(entryPath); assertArtifactPath(workerPath);
  if (serviceWorkerPath !== undefined && serviceWorkerPath !== SERVICE_WORKER_PATH) {
    throw new Error('The service worker must be emitted at the stable application-root service-worker.js path');
  }
  const expected = new Set(), aliases = new Set();
  const add = name => {
    assertArtifactPath(name);
    const folded = name.toLowerCase();
    if (aliases.has(folded)) throw new Error(`Duplicate or case-aliased deployment output: ${name}`);
    expected.add(name); aliases.add(folded);
  };
  const scriptOwners = [entryPath, workerPath, ...(serviceWorkerPath ? [serviceWorkerPath] : [])];
  const maps = scriptOwners.map(path => path + '.map');
  for (const name of emittedPaths) {
    assertArtifactPath(name);
    if (name === MANIFEST) throw new Error('The deployment manifest cannot be a bundler output');
    if (/\.map$/i.test(name) && !maps.includes(name)) throw new Error(`Unowned emitted source map: ${name}`);
    add(name);
    if (/\.m?js$/i.test(name) && !scriptOwners.includes(name)) throw new Error(`Unowned emitted script: ${name}`);
  }
  for (const name of ['index.html', ...scriptOwners, ...maps]) {
    if (!expected.has(name)) throw new Error(`Required emitted bundle path is missing: ${name}`);
  }
  for (const source of qualifiedPublicFiles(snapshot)) {
    const name = source.path.slice('public/'.length);
    if (/\.map$/i.test(name)) throw new Error(`Unowned public source map: ${name}`);
    add(name);
  }
  add(MANIFEST);
  // Qualify membership from the bundle and reviewed public inputs. Unknown
  // leftovers must not become runtime assets merely because they are on disk.
  // Vite owns output removal; manifest publication never deletes a file.
  const inventory = treeFiles(outDir, outDir);
  const actual = new Set(inventory.map(file => file.path));
  for (const name of actual) if (!expected.has(name)) throw new Error(`Unowned deployment output: ${name}`);
  for (const name of expected) if (name !== MANIFEST && !actual.has(name)) throw new Error(`Missing deployment output: ${name}`);
  // Source maps are debugging metadata and are never executed or fetched by the
  // viewer. The manifest excludes itself to avoid a circular content digest.
  const records = inventory.filter(file => file.path !== MANIFEST && !file.path.endsWith('.map'));
  for (const source of qualifiedPublicFiles(snapshot)) {
    const copied = records.find(record => record.path === source.path.slice('public/'.length));
    if (!copied || copied.bytes !== source.bytes || copied.sha256 !== source.sha256) {
      const kind = source.path.startsWith('public/wasm/') ? 'native artifact' : 'public asset';
      throw new Error(`Copied ${kind} differs from qualified input: ${source.path}`);
    }
  }
  for (let index = 0; index < maps.length; ++index) {
    const map = JSON.parse(readFileSync(resolve(outDir, maps[index]), 'utf8'));
    const owner = scriptOwners[index];
    if (map.version !== 3 || map.file !== basename(owner) || !Array.isArray(map.sources) || !map.sources.length ||
        !Array.isArray(map.sourcesContent) || map.sourcesContent.length !== map.sources.length ||
        !readFileSync(resolve(outDir, owner), 'utf8').includes(`sourceMappingURL=${basename(maps[index])}`)) {
      throw new Error(`Current emitted source map does not belong to its entry/worker: ${maps[index]}`);
    }
  }
  const htmlPath = resolve(outDir, 'index.html');
  const html = readFileSync(htmlPath, 'utf8');
  const protectedHtml = protectHtml(html, records, entryPath);
  const finalRecords = records.map(record => record.path === 'index.html' ?
    { ...record, bytes: Buffer.byteLength(protectedHtml), sha256: sha256(protectedHtml) } : record);
  const manifest = createDeploymentManifest(snapshot.descriptor, finalRecords, entryPath, workerPath);
  assertBuildInputsUnchanged(snapshot);
  if (canonicalJson(treeFiles(outDir, outDir)) !== canonicalJson(inventory)) {
    throw new Error('Deployment output changed before manifest publication');
  }
  if (protectedHtml !== html) writeFileSync(htmlPath, protectedHtml, 'utf8');
  writeFileSync(resolve(outDir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  // Guard source changes during final hashing as well as during bundling.
  assertBuildInputsUnchanged(snapshot);
  return manifest;
}

export function workerEntryFileName(chunk) {
  const source = chunk.facadeModuleId?.replaceAll('\\', '/').split(/[?#]/, 1)[0];
  return source && /(?:^|\/)src\/offline\/service\.worker\.ts$/.test(source)
    ? SERVICE_WORKER_PATH : 'assets/[name]-[hash].js';
}

export function workerClosurePlugin() {
  return {
    name: 'splatview-worker-closure',
    generateBundle(_options, bundle) {
      const chunks = Object.values(bundle).filter(output => output.type === 'chunk');
      if (chunks.length !== 1 || chunks[0].imports.length || chunks[0].dynamicImports.length) {
        throw new Error('Each document/service worker must be one self-contained module bundle');
      }
      if (workerEntryFileName(chunks[0]) === SERVICE_WORKER_PATH &&
          chunks[0].moduleIds?.some(id => /(?:^|\/)src\/generated\/buildIdentity\.ts$/.test(id.replaceAll('\\', '/').split(/[?#]/, 1)[0]))) {
        throw new Error('The generic service worker cannot embed the generated application build identity');
      }
    },
  };
}

export function assertApplicationClosure(bundle) {
  const chunks = Object.values(bundle).filter(output => output.type === 'chunk');
  const entries = chunks.filter(output => output.isEntry);
  if (chunks.length !== 1 || entries.length !== 1 || entries[0].imports.length || entries[0].dynamicImports.length) {
    throw new Error('Application entry must be one self-contained module bundle protected by HTML integrity');
  }
  return entries[0].fileName;
}

export function emittedBundlePaths(bundle) {
  const paths = new Set(Object.keys(bundle));
  for (const output of Object.values(bundle)) {
    if (output.type === 'chunk' && output.map) {
      // Rolldown writes chunk maps from metadata; Vite's worker plugin emits
      // worker maps as assets. Neither map path is inferred from disk leftovers.
      if (!output.sourcemapFileName) throw new Error('Emitted chunk source map has no output filename');
      paths.add(output.sourcemapFileName);
    }
  }
  return [...paths].sort();
}

export function webBuildIdentityPlugin() {
  let snapshot;
  let config;
  return {
    name: 'splatview-build-identity',
    enforce: 'pre',
    configResolved(resolved) {
      config = resolved;
      if (config.command === 'build') {
        // Refuse unsafe/redirected output before Vite empties it. Post-write
        // qualification is too late to guard an existing directory junction.
        currentOutputDirectory({ root: config.root }, resolve(config.root, config.build.outDir));
        if (config.build.emptyOutDir !== true) throw new Error('Deployment builds require an explicitly clean dist output');
      }
      if (config.mode === 'test' || process.env.VITEST) return;
      snapshot = prepareBuild(config.root);
      if (config.command === 'serve') config.logger.info('SplatView development uses an unbundled module graph; production artifact qualification requires npm run build + preview.');
    },
    writeBundle(_options, bundle) {
      if (!snapshot || config.command !== 'build') return;
      const entryPath = assertApplicationClosure(bundle);
      const workers = Object.keys(bundle).filter(path => /(?:^|\/)document\.worker-[A-Za-z0-9_-]+\.js$/.test(path));
      if (workers.length !== 1) throw new Error('Ambiguous document-worker output');
      if (!Object.hasOwn(bundle, SERVICE_WORKER_PATH) || bundle[SERVICE_WORKER_PATH].type !== 'asset') {
        throw new Error('Production requires the self-contained application-root service-worker.js output');
      }
      const outDir = currentOutputDirectory(snapshot, resolve(config.root, config.build.outDir));
      copyQualifiedPublic(snapshot, outDir);
      const manifest = writeDeploymentManifest(snapshot, outDir, entryPath, workers[0], emittedBundlePaths(bundle), SERVICE_WORKER_PATH);
      config.logger.info(`SplatView deployment ${manifest.deploymentId}: ${manifest.artifacts.length} qualified runtime artifacts`);
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== 'prepare') throw new Error('Usage: node tools/web-build.mjs prepare');
  const snapshot = prepareBuild();
  process.stdout.write(`Prepared application identity ${snapshot.descriptor.appInputId}\n`);
}
