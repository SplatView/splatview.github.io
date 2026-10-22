import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import { copyFile, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildOrbitTrace, buildSplatFixture, createPrivateOutputDirectory, validateOutputDirectory, writeFixtureSet } from '../tools/bench/build-fixtures.ts';

const temporaryRoots: string[] = [];
async function workspace(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'splatview-benchmark-fixture-')));
  temporaryRoots.push(root); return root;
}
afterEach(async () => { for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true }); });

test('fixed workload has exact byte length and literal independent off-grid anchor records', () => {
  const bytes = buildSplatFixture(); assert.equal(bytes.byteLength, 8_192_000);
  const hex = (id: number): string => Buffer.from(bytes.subarray(id * 32, (id + 1) * 32)).toString('hex');
  assert.equal(hex(0), '000000c1 00000000 00000000 0000803a 0000003b 0000803b ff0000ff ff808080'.replaceAll(' ', ''));
  assert.equal(hex(1), '00000041 00000000 00000000 0000803a 0000003b 0000803b 00ff00ff ff808080'.replaceAll(' ', ''));
  assert.equal(hex(2), '00000000 00000041 00000000 0000803a 0000003b 0000803b 0000ffff ff808080'.replaceAll(' ', ''));
  assert.equal(hex(3), '0000e4bf 0000c4bf 00001ec0 0000803a 0000003b 0000803b ff0000ff ff808080'.replaceAll(' ', ''));
});

test('source order crosses independent row, plane and final-record coordinate anchors', () => {
  const bytes = buildSplatFixture(), data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const position = (id: number): number[] => [data.getFloat32(id * 32, true), data.getFloat32(id * 32 + 4, true), data.getFloat32(id * 32 + 8, true)];
  assert.deepEqual(position(63), [1.96875, -1.53125, -2.46875]);
  assert.deepEqual(position(64), [-1.96875, -1.46875, -2.46875]);
  assert.deepEqual(position(3199), [1.96875, 1.53125, -2.46875]);
  assert.deepEqual(position(3200), [-1.96875, -1.53125, -2.40625]);
  assert.deepEqual(position(255999), [1.96875, 1.53125, 2.46875]);
  assert.deepEqual([...bytes.subarray(255999 * 32 + 24, 255999 * 32 + 32)], [255, 0, 0, 255, 255, 128, 128, 128]);
});

test('repeat construction is byte-deterministic and callers cannot mutate a later result', () => {
  const first = buildSplatFixture(), second = buildSplatFixture();
  assert.deepEqual(first, second); first[0] = 255;
  assert.equal(second[0], 0); assert.equal(buildSplatFixture()[0], 0);
});

test('orbit actions explicitly retain 5 second warmup, 30 second measured orbit and hidden idle without observations', () => {
  const trace = buildOrbitTrace(); assert.deepEqual(trace, buildOrbitTrace());
  assert.equal(trace.warmupMs, 5000); assert.equal(trace.durationMs, 30000); assert.equal(trace.idleHiddenMs, 1000);
  const [warmup, measured, hidden] = trace.phases;
  assert.equal(warmup!.samples.length, 21); assert.equal(measured!.samples.length, 121);
  assert.deepEqual(measured!.samples[0], { atMs: 0, camera: [0, 0, 0, 0, 0, 24, 1, 45, 1, 0, 1.6] });
  assert.equal(measured!.samples[60]!.atMs, 15000); assert.equal(measured!.samples[60]!.camera[3], Math.PI);
  assert.equal(measured!.samples[120]!.atMs, 30000); assert.equal(measured!.samples[120]!.camera[3], 2 * Math.PI);
  assert.equal(hidden!.visible, false); assert.deepEqual(hidden!.samples, []);
  assert.equal(trace.measuredOverdraw, null); assert.equal(trace.observedTimings, null);
  for (const phase of trace.phases) for (const sample of phase.samples)
    assert(sample.camera.every(Number.isFinite) && Number.isFinite(sample.atMs));
});

test('private output grammar refuses traversal, absolute paths, public assets and portable-device hazards', () => {
  assert.equal(validateOutputDirectory('.build/bench-fixtures/run-20261015-01'), '.build/bench-fixtures/run-20261015-01');
  for (const invalid of ['.build/bench-fixtures/..', '.build/bench-fixtures/../elsewhere', '.build/bench-fixtures/a/b',
    '.build\\bench-fixtures\\run', '/tmp/fixture', 'C:/fixture', 'public/fixture', 'dist/fixture',
    '.build/bench-fixtures/CON', '.build/bench-fixtures/con.txt', '.build/bench-fixtures/nul',
    '.build/bench-fixtures/aux.', '.build/bench-fixtures/run.', '.build/bench-fixtures/has space'])
    assert.throws(() => validateOutputDirectory(invalid));
});

test('private output creation is exclusive and preserves an existing diagnostic leaf', async () => {
  const root = await workspace(), logical = '.build/bench-fixtures/exclusive-case';
  const output = await createPrivateOutputDirectory(root, logical);
  const marker = join(output, 'prior-diagnostic.txt'); await writeFile(marker, 'retained prior attempt\n', { flag: 'wx' });
  await assert.rejects(createPrivateOutputDirectory(root, logical), /already exists/);
  assert.equal(await readFile(marker, 'utf8'), 'retained prior attempt\n');
});

test('linked private-output ancestor is refused before any target creation', async () => {
  const root = await workspace(), outside = join(root, 'outside'); await mkdir(outside);
  await symlink(outside, join(root, '.build'), 'junction');
  await assert.rejects(createPrivateOutputDirectory(root, '.build/bench-fixtures/linked-case'), /linked|resolve/);
  await assert.rejects(readFile(join(outside, 'bench-fixtures/linked-case/fixture.splat')));
});

test('a non-directory private ancestor is retained and refused', async () => {
  const root = await workspace(), marker = join(root, '.build'); await writeFile(marker, 'not a directory\n', { flag: 'wx' });
  await assert.rejects(createPrivateOutputDirectory(root, '.build/bench-fixtures/non-directory'), /not regular/);
  assert.equal(await readFile(marker, 'utf8'), 'not a directory\n');
});

test('prepare output stays unqualified until independently pinned; default rejects changed pinned identities', async () => {
  const root = await workspace();
  const files = ['tests/fixtures/bench/manifest-v1.json', 'tools/bench/build-fixtures.ts',
    'native/upstream/splatview/THIRD-PARTY-NOTICES.txt',
    'native/upstream/splatview/third_party/format-reference-licenses/playcanvas.txt'];
  for (const path of files) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await copyFile(new URL(`../${path}`, import.meta.url), join(root, path));
  }
  const manifestPath = join(root, files[0]!);
  const specification = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
  specification.status = 'unsealed'; await writeFile(manifestPath, JSON.stringify(specification));
  await assert.rejects(writeFixtureSet({ workspaceRoot: root, outputDirectory: '.build/bench-fixtures/unsealed-refused' }), /unsealed/);
  const prepared = await writeFixtureSet({ workspaceRoot: root, outputDirectory: '.build/bench-fixtures/prepared', prepare: true });
  const candidatePath = join(root, '.build/bench-fixtures/prepared/manifest.candidate.json');
  const candidate = JSON.parse(await readFile(candidatePath, 'utf8')) as Record<string, unknown>;
  assert.equal(candidate.status, 'prepared');
  const receipt = JSON.parse(await readFile(join(root, prepared.receipt.path), 'utf8')) as {
    qualification: string; mode: string; outputs: { path: string }[];
  };
  assert.equal(receipt.qualification, 'construction-only-not-observed-performance'); assert.equal(receipt.mode, 'prepare');
  assert.deepEqual(receipt.outputs.map(output => output.path.split('/').at(-1)), ['fixture.splat', 'orbit-trace.json', 'manifest.candidate.json']);
  await writeFile(manifestPath, JSON.stringify(candidate));
  await assert.rejects(writeFixtureSet({ workspaceRoot: root, outputDirectory: '.build/bench-fixtures/prepared-refused' }), /unsealed/);
  // Unit setup only: this deliberately sets the independent-review flag to exercise reproducibility checks.
  // It does not publish a root pin or qualify a fixture for performance collection.
  candidate.status = 'pinned'; await writeFile(manifestPath, JSON.stringify(candidate));
  const pinned = await writeFixtureSet({ workspaceRoot: root, outputDirectory: '.build/bench-fixtures/pinned-unit' });
  assert.equal(pinned.identity.inputSha256, prepared.identity.inputSha256);
  const identity = candidate.identity as Record<string, unknown>;
  identity.inputSha256 = '0'.repeat(64); await writeFile(manifestPath, JSON.stringify(candidate));
  await assert.rejects(writeFixtureSet({ workspaceRoot: root, outputDirectory: '.build/bench-fixtures/mismatch-refused' }), /identities differ/);
  assert.equal((JSON.parse(await readFile(candidatePath, 'utf8')) as Record<string, unknown>).status, 'prepared');
  await assert.rejects(writeFixtureSet({ workspaceRoot: root, outputDirectory: '.build/bench-fixtures/prepared', prepare: true }), /already exists/);
});
