/** Original analytic construction only; no application parser, native execution or timing.
 * Run with Node 24: node tools/bench/build-fixtures.ts --output-dir .build/bench-fixtures/NEW_ID [--prepare]
 * --prepare writes an unqualified candidate. Default mode requires an independently pinned manifest.
 */
import { createHash } from 'node:crypto';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURE_ID = 'dyadic-grid-256k-sh0-v1';
export const SOURCE_COUNT = 256_000;
export const SPLAT_RECORD_BYTES = 32;
export const CANONICAL_RECORD_BYTES = 144;
export const MANIFEST_PATH = 'tests/fixtures/bench/manifest-v1.json';
export const GENERATOR_PATH = 'tools/bench/build-fixtures.ts';
export const DISTRIBUTION_DOMAIN = 'SplatViewBenchmarkDistribution\0v1\0dyadic-grid-256k-sh0-v1\0';
export const FIXED_CAMERA = [0, 0, 0, 0, 0, 24, 1, 45, 1, 0, 1.6] as const;
export const STANDARD_FRAMEBUFFER = {
  id: 'standard-1280x800-dpr1', kind: 'standard', cssWidth: 1280, cssHeight: 800, width: 1280, height: 800, dpr: 1,
} as const;

type JsonRecord = Record<string, unknown>;
export interface FileIdentity { path: string; bytes: number; sha256: string }
export interface ConstructionIdentity {
  inputSha256: string;
  sourceOrderSha256: string;
  distributionSha256: string;
  expectedSceneSha256: string;
  fullMembershipSha256: string;
  traceSha256: string;
  projectionSha256: string;
}
export interface OrbitTrace {
  schemaVersion: 1;
  kind: 'splatview-benchmark-camera-trace';
  id: 'orbit-fixed-v1';
  fixtureId: typeof FIXTURE_ID;
  status: 'intended-actions-only';
  clock: 'milliseconds-from-phase-start';
  cameraStateFields: readonly string[];
  samplePolicy: 'absolute-state-linear-yaw-between-adjacent-samples';
  phaseBoundaryPolicy: 'set-first-camera-state-before-starting-phase-clock';
  framebuffer: typeof STANDARD_FRAMEBUFFER;
  projection: { camera: readonly number[]; coordinateSystem: string; nearFarPolicy: string };
  warmupMs: 5000;
  durationMs: 30000;
  idleHiddenMs: 1000;
  phases: {
    kind: 'warmup' | 'measured-orbit' | 'idle-hidden';
    durationMs: number;
    visible: boolean;
    samples: { atMs: number; camera: number[] }[];
  }[];
  measuredOverdraw: null;
  observedTimings: null;
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const jsonBytes = (value: unknown): Uint8Array => Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8');
const positiveZero = (value: number): number => value === 0 ? 0 : value;

/** Fixed 64 x 50 x 80 grid, with three off-grid anchors; source ID is record ordinal. */
function wirePosition(sourceId: number): readonly [number, number, number] {
  if (sourceId === 0) return [-8, 0, 0];
  if (sourceId === 1) return [8, 0, 0];
  if (sourceId === 2) return [0, 8, 0];
  return [(2 * (sourceId % 64) - 63) / 32,
    (2 * (Math.floor(sourceId / 64) % 50) - 49) / 32,
    (2 * Math.floor(sourceId / 3200) - 79) / 32];
}

/** Raw little-endian .splat; always exactly 8,192,000 bytes. */
export function buildSplatFixture(): Uint8Array {
  const bytes = new Uint8Array(SOURCE_COUNT * SPLAT_RECORD_BYTES), view = new DataView(bytes.buffer);
  for (let sourceId = 0; sourceId < SOURCE_COUNT; sourceId++) {
    const offset = sourceId * SPLAT_RECORD_BYTES, [x, y, z] = wirePosition(sourceId);
    view.setFloat32(offset, x, true); view.setFloat32(offset + 4, y, true); view.setFloat32(offset + 8, z, true);
    view.setFloat32(offset + 12, 2 ** -10, true); view.setFloat32(offset + 16, 2 ** -9, true);
    view.setFloat32(offset + 20, 2 ** -8, true);
    bytes[offset + 24 + sourceId % 3] = 255; bytes[offset + 27] = 255;
    bytes.set([255, 128, 128, 128], offset + 28);
  }
  return bytes;
}

/** Analytic expected attributes, constructed without importing any production decode/math. */
function canonicalSceneBytes(): Uint8Array {
  const bytes = new Uint8Array(SOURCE_COUNT * CANONICAL_RECORD_BYTES), view = new DataView(bytes.buffer);
  for (let sourceId = 0; sourceId < SOURCE_COUNT; sourceId++) {
    const offset = sourceId * CANONICAL_RECORD_BYTES, [x, y, z] = wirePosition(sourceId);
    view.setFloat32(offset, positiveZero(x), true); view.setFloat32(offset + 4, positiveZero(-y), true);
    view.setFloat32(offset + 8, positiveZero(-z), true); view.setFloat32(offset + 12, 1, true);
    view.setFloat32(offset + 16, 2 ** -20, true); view.setFloat32(offset + 28, 2 ** -18, true);
    view.setFloat32(offset + 36, 2 ** -16, true);
    for (let channel = 0; channel < 3; channel++) view.setUint16(offset + 48 + channel * 2,
      channel === sourceId % 3 ? 0x3f17 : 0xbf17, true);
    // Allocation initialized all covariance off-diagonals, padding and absent SH to +0.
  }
  return bytes;
}

function sourceOrderBytes(): Uint8Array {
  const bytes = new Uint8Array(SOURCE_COUNT * 4), view = new DataView(bytes.buffer);
  for (let sourceId = 0; sourceId < SOURCE_COUNT; sourceId++) view.setUint32(sourceId * 4, sourceId, true);
  return bytes;
}

/** Intended absolute camera actions only. Collection must supply its own actual time/overdraw observations. */
export function buildOrbitTrace(): OrbitTrace {
  const samples = (durationMs: number): { atMs: number; camera: number[] }[] => {
    const count = durationMs / 250;
    return Array.from({ length: count + 1 }, (_, index) => {
      const camera: number[] = [...FIXED_CAMERA]; camera[3] = 2 * Math.PI * (index / count);
      return { atMs: index * 250, camera };
    });
  };
  return {
    schemaVersion: 1, kind: 'splatview-benchmark-camera-trace', id: 'orbit-fixed-v1', fixtureId: FIXTURE_ID,
    status: 'intended-actions-only', clock: 'milliseconds-from-phase-start',
    cameraStateFields: ['targetX', 'targetY', 'targetZ', 'yawRadians', 'pitchRadians', 'distance', 'speed', 'verticalFovDegrees', 'yUp', 'rollRadians', 'aspect'],
    samplePolicy: 'absolute-state-linear-yaw-between-adjacent-samples',
    phaseBoundaryPolicy: 'set-first-camera-state-before-starting-phase-clock',
    framebuffer: { ...STANDARD_FRAMEBUFFER },
    projection: { camera: [...FIXED_CAMERA], coordinateSystem: 'RUB-right-up-backward', nearFarPolicy: 'captured-native-camera-defaults; runner records actual projection bytes' },
    warmupMs: 5000, durationMs: 30000, idleHiddenMs: 1000,
    phases: [
      { kind: 'warmup', durationMs: 5000, visible: true, samples: samples(5000) },
      { kind: 'measured-orbit', durationMs: 30000, visible: true, samples: samples(30000) },
      { kind: 'idle-hidden', durationMs: 1000, visible: false, samples: [] },
    ],
    measuredOverdraw: null, observedTimings: null,
  };
}

export function buildConstructionIdentity(): ConstructionIdentity {
  const scene = canonicalSceneBytes(), order = sourceOrderBytes(), trace = buildOrbitTrace();
  const membershipSha256 = sha256(order);
  return {
    inputSha256: sha256(buildSplatFixture()), sourceOrderSha256: membershipSha256,
    distributionSha256: createHash('sha256').update(DISTRIBUTION_DOMAIN, 'utf8').update(scene).digest('hex'),
    expectedSceneSha256: sha256(scene), fullMembershipSha256: membershipSha256,
    traceSha256: sha256(jsonBytes(trace)),
    projectionSha256: sha256(jsonBytes({ framebuffer: trace.framebuffer, projection: trace.projection })),
  };
}

/** A single portable private run ID; absolute paths, traversal and Windows device names are refused. */
export function validateOutputDirectory(value: string): string {
  if (!/^\.build\/bench-fixtures\/[a-z0-9][a-z0-9._-]{0,79}$/.test(value))
    throw new Error('Output must be .build/bench-fixtures/<new-lowercase-run-id>');
  const runId = value.slice('.build/bench-fixtures/'.length);
  if (runId.endsWith('.') || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(runId))
    throw new Error('Output run ID is not a portable directory name');
  return value;
}

function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
function within(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix.length > 0 && !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`);
}
async function absent(path: string): Promise<boolean> {
  try { await lstat(path); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error; }
}
async function checkedDirectory(root: string, path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Directory is linked or not regular: ${path}`);
  const actual = await realpath(path);
  if (!samePath(actual, path) || (!samePath(root, path) && !within(root, actual))) throw new Error('Directory resolves outside the intended workspace');
}

/** Creates only the validated private directory. Existing run directories are never reused. */
export async function createPrivateOutputDirectory(workspaceRoot: string, outputDirectory: string): Promise<string> {
  validateOutputDirectory(outputDirectory);
  const root = resolve(workspaceRoot), canonicalRoot = await realpath(root);
  if (!samePath(root, canonicalRoot)) throw new Error('Workspace root must resolve directly without links');
  await checkedDirectory(root, root);
  const output = resolve(root, outputDirectory);
  if (!within(root, output)) throw new Error('Output resolves outside the intended workspace');
  // Inspect all existing ancestors before creating anything. This also catches dangling links.
  const ancestors = [resolve(root, '.build'), resolve(root, '.build/bench-fixtures')];
  for (const ancestor of ancestors) if (!await absent(ancestor)) await checkedDirectory(root, ancestor);
  if (!await absent(output)) throw new Error('Output directory already exists; choose a fresh run ID');
  for (const ancestor of ancestors) {
    await checkedDirectory(root, dirname(ancestor));
    if (await absent(ancestor)) await mkdir(ancestor);
    await checkedDirectory(root, ancestor);
  }
  await checkedDirectory(root, dirname(output));
  await mkdir(output); // Exclusive directory creation remains authoritative if another writer races.
  await checkedDirectory(root, output);
  return output;
}

async function readRegularFile(root: string, path: string, maximumBytes: number): Promise<Uint8Array> {
  const absolute = resolve(root, path);
  if (!within(root, absolute)) throw new Error('Input file is outside the workspace');
  const parts = relative(root, absolute).split(sep);
  let ancestor = root;
  for (const part of parts.slice(0, -1)) { ancestor = join(ancestor, part); await checkedDirectory(root, ancestor); }
  const stat = await lstat(absolute);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > maximumBytes) throw new Error(`Input is linked, oversized or not regular: ${path}`);
  if (!samePath(await realpath(absolute), absolute)) throw new Error('Input file resolves through a link');
  const handle = await open(absolute, 'r');
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size !== stat.size || opened.size > maximumBytes)
      throw new Error('Input file changed before bounded read');
    const bytes = new Uint8Array(opened.size + 1);
    let used = 0;
    while (used < bytes.byteLength) {
      const { bytesRead } = await handle.read(bytes, used, bytes.byteLength - used, null);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used !== opened.size) throw new Error('Input file changed during bounded read');
    return bytes.subarray(0, used);
  } finally { await handle.close(); }
}

function record(value: unknown, description: string): JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${description}`);
  return value as JsonRecord;
}
function fileIdentity(path: string, bytes: Uint8Array): FileIdentity { return { path, bytes: bytes.byteLength, sha256: sha256(bytes) }; }

/** Replaces only construction-derived nulls. Root must independently check and pin the resulting candidate. */
function preparedManifest(specification: JsonRecord, identity: ConstructionIdentity, generator: FileIdentity,
  references: FileIdentity[]): JsonRecord {
  const result = structuredClone(specification);
  result.status = 'prepared'; result.identity = identity; result.generator = generator; result.referenceFiles = references;
  return result;
}

export async function writeFixtureSet(options: {
  workspaceRoot?: string; outputDirectory: string; prepare?: boolean;
}): Promise<{ outputDirectory: string; identity: ConstructionIdentity; receipt: FileIdentity }> {
  const root = resolve(options.workspaceRoot ?? process.cwd());
  validateOutputDirectory(options.outputDirectory);
  const sourceBytes = await readRegularFile(root, MANIFEST_PATH, 1024 * 1024);
  const specification = record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(sourceBytes)), 'fixture manifest');
  if (specification.schemaVersion !== 1 || specification.kind !== 'splatview-original-benchmark-fixture'
    || specification.id !== FIXTURE_ID) throw new Error('Unexpected benchmark fixture manifest');
  const generatorBytes = await readRegularFile(root, GENERATOR_PATH, 1024 * 1024);
  const referencePaths = [
    'native/upstream/splatview/THIRD-PARTY-NOTICES.txt',
    'native/upstream/splatview/third_party/format-reference-licenses/playcanvas.txt',
  ];
  const references: FileIdentity[] = [];
  for (const path of referencePaths) references.push(fileIdentity(path, await readRegularFile(root, path, 1024 * 1024)));
  const generator = fileIdentity(GENERATOR_PATH, generatorBytes), identity = buildConstructionIdentity();
  const candidate = preparedManifest(specification, identity, generator, references);
  if (!options.prepare) {
    if (specification.status !== 'pinned') throw new Error('Fixture manifest is unsealed; independently verify --prepare output before pinning');
    // Independently pinned construction identities and source references must match this execution.
    if (JSON.stringify({ ...candidate, status: 'pinned' }) !== JSON.stringify(specification))
      throw new Error('Pinned fixture construction identities differ; refusing output');
  }
  const output = await createPrivateOutputDirectory(root, options.outputDirectory);
  const outputs: FileIdentity[] = [];
  const write = async (name: string, bytes: Uint8Array): Promise<FileIdentity> => {
    await checkedDirectory(root, root); await checkedDirectory(root, resolve(root, '.build'));
    await checkedDirectory(root, dirname(output)); await checkedDirectory(root, output);
    const path = join(output, name), handle = await open(path, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    const logicalPath = `${options.outputDirectory}/${name}`;
    const actual = await readRegularFile(root, logicalPath, 64 * 1024 * 1024);
    if (sha256(actual) !== sha256(bytes)) throw new Error('Written fixture output differs; partial directory retained for diagnosis');
    const entry = fileIdentity(logicalPath, bytes); outputs.push(entry); return entry;
  };
  await write('fixture.splat', buildSplatFixture());
  await write('orbit-trace.json', jsonBytes(buildOrbitTrace()));
  if (options.prepare) await write('manifest.candidate.json', jsonBytes(candidate));
  const receipt = await write('fixture-receipt.json', jsonBytes({
    schemaVersion: 1, kind: 'splatview-benchmark-fixture-construction-receipt', fixtureId: FIXTURE_ID,
    mode: options.prepare ? 'prepare' : 'pinned-build', qualification: 'construction-only-not-observed-performance',
    sourceManifest: fileIdentity(MANIFEST_PATH, sourceBytes), generator, referenceFiles: references,
    identity, outputs: [...outputs],
    limitations: ['No native decoder or export was executed', 'No browser was launched',
      'Trace is intended actions; timings and overdraw remain unmeasured',
      'Prepared candidates require independent oracle verification before root pinning'],
  }));
  return { outputDirectory: options.outputDirectory, identity, receipt };
}

async function main(args: string[]): Promise<void> {
  const prepare = args.length === 3 && args[2] === '--prepare';
  if (args.length !== (prepare ? 3 : 2) || args[0] !== '--output-dir')
    throw new Error('Usage: build-fixtures.ts --output-dir .build/bench-fixtures/NEW_ID [--prepare]');
  const result = await writeFixtureSet({ outputDirectory: args[1]!, prepare });
  process.stdout.write(JSON.stringify(result) + '\n');
}

if (process.argv[1] && samePath(resolve(process.argv[1]), fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n'); process.exitCode = 1;
  });
}
