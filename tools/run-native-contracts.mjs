// Execute the original linked contract mains and retain exact artifact evidence.
// public/wasm is accessed only through the five explicit publication filenames.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requireValue = (value, message) => { if (!value) throw new Error(message); };
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const mains = [
  ['source-hash', 'SPLATVIEW_SOURCE_HASH_CONTRACTS_PASS '],
  ['operation-receipt', 'SPLATVIEW_OPERATION_RECEIPT_CONTRACTS_PASS '],
  ['geometry', 'SPLATVIEW_GEOMETRY_CONTRACTS_PASS '],
  ['live-selection', 'Live selection contracts passed:'],
  ['response', 'SPLATVIEW_RESPONSE_CONTRACTS_PASS '],
  ['allocation-census', 'SPLATVIEW_ALLOCATION_CENSUS_CONTRACTS_PASS '],
  ['spz-cleanup', 'SPLATVIEW_SPZ_CLEANUP_CONTRACTS_PASS '],
  ['sog-export', 'SPLATVIEW_SOG_EXPORT_CONTRACTS_PASS '],
  ['attribute-export', 'SPLATVIEW_ATTRIBUTE_EXPORT_CONTRACTS_PASS '],
  ['spz3-export', 'SPLATVIEW_SPZ3_EXPORT_CONTRACTS_PASS '],
  ['spz4-export', 'SPLATVIEW_SPZ4_EXPORT_CONTRACTS_PASS '],
  ['json-cleanup', 'SPLATVIEW_JSON_CLEANUP_CONTRACTS_PASS '],
  ['morphology', 'SPLATVIEW_MORPHOLOGY_CONTRACTS_PASS '],
  ['filter', 'Filter contracts passed:'],
  ['filter-gizmo', 'SPLATVIEW_FILTER_GIZMO_CONTRACTS_PASS '],
  ['transform-session', 'SPLATVIEW_TRANSFORM_SESSION_CONTRACTS_PASS '],
  ['transform-gizmo', 'SPLATVIEW_TRANSFORM_GIZMO_CONTRACTS_PASS '],
  ['opacity-session', 'SPLATVIEW_OPACITY_SESSION_CONTRACTS_PASS '],
  ['auto-color', 'AUTO_COLOR_NATIVE_CONTRACTS_PASS '],
  ['color-session', 'SPLATVIEW_COLOR_SESSION_CONTRACTS_PASS '],
  ['alignment', 'SPLATVIEW_ALIGNMENT_CONTRACTS_PASS '],
  ['camera-transform', 'SPLATVIEW_CAMERA_TRANSFORM_CONTRACTS_PASS '],
  ['floor', 'SPLATVIEW_FLOOR_CONTRACTS_PASS '],
  ['sog-group', 'SPLATVIEW_SOG_GROUP_CONTRACTS_PASS '],
  ['current-view', 'SPLATVIEW_CURRENT_VIEW_CONTRACTS_PASS '],
  ['document-checkpoint', 'SPLATVIEW_DOCUMENT_CHECKPOINT_CONTRACTS_PASS '],
];
const artifacts = [
  ...mains.flatMap(([name]) => ['mjs', 'wasm'].map(extension =>
    `.build/wasm/contracts/splatview-${name}-contracts.${extension}`)),
  ...['splatview-core.mjs', 'splatview-core.wasm', 'splatview-camera.mjs',
    'splatview-camera.wasm', 'build-provenance.json'].map(name => `public/wasm/${name}`),
];

function record(relative) {
  const absolute = path.resolve(root, relative);
  requireValue(absolute.startsWith(root + path.sep), 'Evidence path escapes the workspace.');
  const info = fs.lstatSync(absolute);
  requireValue(info.isFile() && !info.isSymbolicLink() && samePath(fs.realpathSync.native(absolute), absolute),
    `Evidence must be a regular file without links: ${relative}`);
  const bytes = fs.readFileSync(absolute);
  return { path: relative, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}

async function main() {
  const args = process.argv.slice(2);
  requireValue(args.length === 2 && args[0] === '--output' &&
    /^docs\/validation\/runs\/[a-z0-9-]+\/[a-z0-9-]+\.json$/.test(args[1]),
  'Expected --output docs/validation/runs/NEW-RUN/NAME.json.');
  requireValue(samePath(process.execPath, path.join(root, '.tools/node-v24.21.0-win-x64/node.exe')),
    'Use the pinned workspace Node executable.');
  const output = path.join(root, args[1]);
  requireValue(!fs.existsSync(output), 'Execution receipt already exists.');
  const startedAtUtc = new Date().toISOString();
  const inputs = [...artifacts, 'tools/run-native-contracts.mjs'];
  const before = inputs.map(record), invocations = [];
  for (const [name, marker] of mains) {
    const modulePath = `.build/wasm/contracts/splatview-${name}-contracts.mjs`;
    const stdout = [], stderr = []; let outputBytes = 0;
    const observe = (lines, stream, value) => {
      const line = String(value); outputBytes += Buffer.byteLength(line) + 1;
      requireValue(outputBytes <= 65536 && stdout.length + stderr.length < 256,
        'Native contract output exceeded its allowance.');
      lines.push(line); stream.write(line + '\n');
    };
    const module = await import(pathToFileURL(path.join(root, modulePath)).href);
    requireValue(typeof module.default === 'function', 'Missing actual contract factory.');
    const started = new Date().toISOString();
    await module.default({ arguments: [], noInitialRun: false,
      print: value => observe(stdout, process.stdout, value),
      printErr: value => observe(stderr, process.stderr, value) });
    requireValue(process.exitCode === undefined || process.exitCode === 0, 'Native main returned a failure.');
    const expectedDiagnostics = name === 'spz-cleanup' ? new Map([
      ['[SPZ] deserializePackedGaussians: version=2, numPoints=2, shDegree=0, fractionalBits=12, antialiased=0, hasExtensions=0', 2],
      ['[SPZ] deserializePackedGaussians: version=3, numPoints=2, shDegree=0, fractionalBits=12, antialiased=0, hasExtensions=0', 2],
      ['[SPZ] deserializePackedGaussians: version=3, numPoints=2048, shDegree=0, fractionalBits=12, antialiased=0, hasExtensions=0', 11],
    ]) : name === 'auto-color' ? new Map([
      ['PASS desktop-aligned native color metadata: 9 contract suites; 287 assertions.', 1],
      ['target session=704 snapshot=248 context=56 key=88 request=192 bakePlan=64 observed metadata-transition allocations=0', 1],
    ]) : new Map();
    for (const line of stdout.slice(0, -1)) {
      const remaining = expectedDiagnostics.get(line);
      requireValue(remaining > 0, `Unexpected ${name} diagnostic output.`);
      expectedDiagnostics.set(line, remaining - 1);
    }
    requireValue(stderr.length === 0 && stdout.length > 0 && stdout.at(-1).startsWith(marker) &&
      [...expectedDiagnostics.values()].every(count => count === 0),
      `Unexpected ${name} contract output.`);
    invocations.push({ name, modulePath, actualFactoryMainInvoked: true,
      startedAtUtc: started, finishedAtUtc: new Date().toISOString(), stdout, stderr });
  }
  const after = inputs.map(record);
  requireValue(JSON.stringify(before) === JSON.stringify(after), 'Execution inputs changed during the run.');
  const provenance = JSON.parse(fs.readFileSync(path.join(root, 'public/wasm/build-provenance.json'), 'utf8'));
  const receipt = { schemaVersion: 1, kind: 'linked-native-contract-main-execution', status: 'passed',
    executable: process.execPath, startedAtUtc, finishedAtUtc: new Date().toISOString(),
    nativeInputId: provenance.nativeInputId, before, after, invocations,
    scope: 'Actual linked source-hash, geometry, live-selection, response, allocation-census, SPZ cleanup, admitted SOG/SOGS export with original namespace/order-signature-only byte oracle and genuine grant/backend/metadata/codec/publication refusal, admitted attribute export, desktop-byte-compatible admitted SPZ v3 gzip export, bounded streaming SPZ v4 export, JSON cleanup, cooperative Sigma/Volume morphology and source-derived range metadata, six fixed-baseline selection filters, fixed-storage filter CSS gizmos, retained absolute manual-transform sessions/cooperative bakes, general transform matrix gizmos/composer bindings, Auto Color analysis, color-session, Center/Scale/three-point plane alignment, cooperative Floor detection/result/alignment, grouped-v1/v2-SH0-3 borrowed open and camera-transform/frame/orientation binding mains. Not browser, arbitrary-command quota, visual or performance acceptance.' };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  process.stdout.write(`Native execution receipt: ${args[1]}\n`);
}
main().catch(error => { process.stderr.write(String(error?.stack ?? error) + '\n'); process.exitCode = 1; });
