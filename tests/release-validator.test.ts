import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { canonicalJson, collectApplicationInputs, createDeploymentManifest, descriptorFromInputs } from '../tools/web-build.mjs';
import { digest, relativePath, uniquePaths, Workspace } from '../tools/release/files.ts';
import { parseCsv } from '../tools/release/ledger.ts';
import { shapeIssues } from '../tools/release/schema.ts';
import { inspectShipping } from '../tools/release/shipping.ts';
import { argumentOption, validateRelease } from '../tools/release/validate.ts';
import type { CapabilityLedger, ExpectedInventory, FileRef, ReleaseRequest, SourceCapture } from '../tools/release/types.ts';

// Synthetic policy workspaces only. No build, command, browser, hardware or performance is attested.
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const json = (value: unknown): string => JSON.stringify(value, null, 2) + '\n';
async function synthetic(options: { publicAssetMismatch?: boolean } = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'splatview-release-policy-'))); roots.push(root);
  const workspace = new Workspace(root);
  const put = async (name: string, value: string): Promise<FileRef> => { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); const bytes = new TextEncoder().encode(value); await writeFile(path.join(root, name), bytes); return { path: name, bytes: bytes.length, sha256: digest(bytes) }; };
  const putJson = (name: string, value: unknown): Promise<FileRef> => put(name, json(value));
  const contract = { schemaVersion: 1, protocolVersion: 1, uiWorkerContract: 1,
    core: { schemaVersion: 1, kind: 'core', abi: 1, variant: 'scalar', mapLayoutVersion: 1, capabilities: {} },
    camera: { schemaVersion: 1, kind: 'camera', abi: 1, variant: 'scalar', capabilities: {} } };
  for (const name of ['index.html', 'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', 'tools/web-build.mjs', 'tools/web-build.d.mts', 'src/main.tsx']) await put(name, 'synthetic byte fixture\n');
  await putJson('tools/public-assets.json', { schemaVersion: 1, files: [] });
  if (options.publicAssetMismatch !== undefined) {
    await put('public/icons/fixture.svg', '<svg>current reviewed source</svg>');
    await putJson('tools/public-assets.json', { schemaVersion: 1, files: ['icons/fixture.svg'] });
  }
  await putJson('native/wasm/runtime-contract.json', contract);
  const native: FileRef[] = [];
  for (const name of ['splatview-core.mjs', 'splatview-core.wasm', 'splatview-camera.mjs', 'splatview-camera.wasm']) native.push(await put('public/wasm/' + name, `synthetic ${name}\n`));
  const nativeInputId = 'a'.repeat(64);
  native.push(await putJson('public/wasm/build-provenance.json', { schemaVersion: 1, nativeInputId, nativeIdentity: { core: { ...contract.core, nativeInputId }, camera: { ...contract.camera, nativeInputId } }, outputs: Object.fromEntries(native.map(row => [path.posix.basename(row.path), { bytes: row.bytes, sha256: row.sha256 }])) }));
  const app = collectApplicationInputs(root);
  const provenance = JSON.parse(await readFile(path.join(root, 'public/wasm/build-provenance.json'), 'utf8')) as unknown;
  const descriptor = descriptorFromInputs(app, contract, provenance);
  const generated = await put('src/generated/buildIdentity.ts', 'export const BUILD_DESCRIPTOR: BuildDescriptor = ' + JSON.stringify(descriptor, null, 2) + ';\n');
  const dist: FileRef[] = [];
  dist.push(await put('dist/index.html', '<title>Synthetic fixture</title>'));
  for (const name of ['assets/app.js', 'assets/worker.js', 'service-worker.js']) dist.push(await put('dist/' + name, `// synthetic\n//# sourceMappingURL=${path.posix.basename(name)}.map\n`));
  for (const row of native) dist.push(await put('dist/wasm/' + path.posix.basename(row.path), await readFile(path.join(root, row.path), 'utf8')));
  if (options.publicAssetMismatch !== undefined) dist.push(await put('dist/icons/fixture.svg', options.publicAssetMismatch ? '<svg>stale deployed copy</svg>' : '<svg>current reviewed source</svg>'));
  const manifest = createDeploymentManifest(descriptor, dist.map(row => ({ ...row, path: row.path.slice(5) })), 'assets/app.js', 'assets/worker.js');
  const manifestRef = await putJson('dist/build-manifest.json', manifest); dist.push(manifestRef);
  for (const name of ['assets/app.js', 'assets/worker.js', 'service-worker.js']) dist.push(await putJson('dist/' + name + '.map', { version: 3, file: path.posix.basename(name), sources: [], mappings: '' }));
  const spec = await put('e2e/synthetic.spec.ts', '// synthetic expected coverage\n');
  const capture: SourceCapture = { schemaVersion: 1, kind: 'splatview-release-source-capture', appInputId: descriptor.appInputId, deploymentId: manifest.deploymentId, applicationInputs: app, nativeFiles: native, distribution: dist, coveredInputs: [spec, generated] };
  const captureRef = await putJson('.build/capture.json', capture);
  const lastRun = await putJson('.build/output/.last-run.json', { status: 'passed', failedTests: [] });
  const report = { config: { rootDir: path.join(root, 'e2e'), projects: [{ name: '', outputDir: path.join(root, '.build/output') }] }, errors: [], stats: { expected: 1, unexpected: 0, flaky: 0, skipped: 0 }, suites: [{ title: 'synthetic.spec.ts', file: 'synthetic.spec.ts', specs: [{ id: 'synthetic-case', title: 'observed synthetic leaf', file: 'synthetic.spec.ts', ok: true, tests: [{ projectName: '', expectedStatus: 'passed', status: 'expected', results: [{ status: 'passed', retry: 0, errors: [], attachments: [] }] }] }] }] };
  const reportRef = await putJson('.build/report.json', report);
  const executable = await put('.tools/runtime.bin', 'synthetic executable bytes; never executed');
  const arguments_ = ['node_modules/@playwright/test/cli.js', 'test', '--output=.build/output', '--reporter=json'];
  const log = await put('.build/command.log', 'synthetic transcript; never executed\n');
  const terminal = { schemaVersion: 1, kind: 'observed-local-command-terminal', workingDirectory: root, executable: path.join(root, executable.path), arguments: arguments_, startedAtUtc: '2026-10-15T00:00:00Z', finishedAtUtc: '2026-10-15T00:01:00Z', exitCode: 0, exception: null, log, report: reportRef, browserOutputDirectory: '.build/output', lastRun };
  const terminalRef = await putJson('.build/terminal.json', terminal);
  const inventory: ExpectedInventory = { schemaVersion: 1, kind: 'splatview-release-expected-inventory', suites: [{ id: 'synthetic-browser', adapter: 'playwright', command: { executable, arguments: arguments_, workingDirectory: '.' }, report: reportRef, coveredInputs: [spec], files: [{ path: spec.path, leaves: [{ id: 'synthetic-case', title: 'observed synthetic leaf', project: '' }] }], outputDirectory: '.build/output', outputFiles: [lastRun], requiredAttachments: [] }] };
  const inventoryRef = await putJson('.build/inventory.json', inventory);
  const sourceCsv = await put('docs/features.csv', 'capability\nSynthetic feature\n');
  const capabilityCsv = await put('docs/capabilities.csv', 'id,desktop_feature,scope,implementation,required_cells,exclusion_reason\nsynthetic-feature,Synthetic feature,retained,implemented,synthetic-cell,\n');
  const desktop = await put('reference/capture.json', '{"synthetic":true}\n');
  const ledger: CapabilityLedger = { schemaVersion: 1, kind: 'splatview-capability-ledger', desktopContract: { revision: 'synthetic-r1', capture: desktop }, sourceFeatureLedger: sourceCsv, capabilityInventory: capabilityCsv, capabilities: [{ id: 'synthetic-feature', desktopFeature: 'Synthetic feature', scope: 'retained', implementation: 'implemented', requiredCells: [{ id: 'synthetic-cell', kind: 'playwright', scope: 'Synthetic validator policy only', configurationIds: [], requiredCaseIds: ['::synthetic-case'] }], approvedDifferenceIds: [], exclusionReason: null }], gates: [{ id: 'real-https', kind: 'https', scope: 'Actual deployed HTTPS workflow', configurationIds: [], requiredCaseIds: [] }], differences: [] };
  const ledgerRef = await putJson('.build/ledger.json', ledger);
  const request: ReleaseRequest = { schemaVersion: 1, kind: 'splatview-release-request', id: 'synthetic-packet', mode: 'bounded', ledger: ledgerRef, shipping: { sourceCapture: captureRef, applicationInputs: app, nativeFiles: native, distribution: dist, manifest: manifestRef }, expectedInventory: inventoryRef, evidence: [{ id: 'synthetic-browser', kind: 'playwright', terminal: terminalRef, expectationId: 'synthetic-browser', fixtureSet: null, applicability: { kind: 'exact', observedAppInputId: descriptor.appInputId, observedDeploymentId: manifest.deploymentId, observedSourceCapture: captureRef, coveredInputs: [spec], review: null } }], requestedCells: ['synthetic-cell'], bindings: [{ cellId: 'synthetic-cell', evidenceId: 'synthetic-browser', caseIds: ['::synthetic-case'] }], claims: { configurations: [], budgets: [] }, review: { identity: 'synthetic-test-policy', atUtc: '2026-10-15T00:02:00Z', reason: 'Synthetic tooling consistency test; no actual release approval' } };
  return { root, workspace, put, putJson, request, capture, ledger, inventory, terminal, report, run: async () => { const reference = await putJson('.build/request.json', request); return validateRelease(new Workspace(root), reference); } };
}

test('release validator qualifies only a bounded exact matched cell and leaves genuine HTTPS pending', async () => {
  const fixture = await synthetic(), result = await fixture.run();
  expect(result.issues).toEqual([]); expect(result.valid).toBe(true); expect(result.boundedAccepted).toBe(true); expect(result.fullEditorAccepted).toBe(false);
  expect(result.status).toBe('pending'); expect(result.acceptedCells).toEqual(['synthetic-cell']); expect(result.pendingCells).toEqual(['real-https']);
});
test('release schema rejects unknown opaque passed evidence and missing external inventory', async () => {
  const fixture = await synthetic(); const raw = { ...fixture.request, evidence: [{ id: 'opaque', kind: 'native', status: 'passed' }] };
  expect(shapeIssues('ReleaseRequest', raw).length).toBeGreaterThan(0);
  const missing = { ...fixture.request } as Record<string, unknown>; delete missing.expectedInventory;
  expect(shapeIssues('ReleaseRequest', missing).length).toBeGreaterThan(0);
});
test.each(['../outside', '/absolute', 'C:/outside', 'a\\b', 'a/../b', 'a//b', 'a/./b', 'a/b.', 'a/b ', 'NUL.txt', 'public/wasm/unknown.wasm'])('release filesystem rejects unsafe or ambiguous path %s', value => { expect(() => relativePath(value)).toThrow(); });
test('release filesystem rejects duplicate paths and case aliases before reading', () => {
  const ref = { path: 'a/File.json', bytes: 0, sha256: '0'.repeat(64) };
  expect(() => uniquePaths([ref, ref], 'test')).toThrow(/Duplicate/u);
  expect(() => uniquePaths([ref, { ...ref, path: 'a/file.json' }], 'test')).toThrow(/case/u);
});
test('release filesystem binds exact bytes/hash and bounded exclusive outputs', async () => {
  const fixture = await synthetic();
  await expect(fixture.workspace.read('e2e/synthetic.spec.ts', { path: 'e2e/synthetic.spec.ts', bytes: 1, sha256: '0'.repeat(64) })).rejects.toThrow(/mismatch/u);
  await expect(new Workspace(fixture.root, 1).read('e2e/synthetic.spec.ts')).rejects.toThrow(/bound/u);
  await fixture.workspace.writeExclusive('.build/exclusive.json', { synthetic: true });
  await expect(fixture.workspace.writeExclusive('.build/exclusive.json', { overwrite: true })).rejects.toThrow();
  expect(JSON.parse(await readFile(path.join(fixture.root, '.build/exclusive.json'), 'utf8'))).toEqual({ synthetic: true });
});
test('release read accounting observes both byte passes and refuses aggregate overflow before another read', async () => {
  const fixture = await synthetic();
  const reference = await fixture.put('.build/read-accounting.bin', '12345');
  const bounded = new Workspace(fixture.root, 5, 19);
  expect(bounded.readBytes).toBe(0);
  await bounded.read(reference.path, reference);
  expect(bounded.readBytes).toBe(10);
  await expect(bounded.read(reference.path, reference)).rejects.toThrow('observed=10 attempted=20 maximum=19');
  expect(bounded.readBytes).toBe(10);
});
test('release filesystem rejects a linked/reparse ancestor and never enumerates native publication', async () => {
  const fixture = await synthetic();
  await symlink(path.join(fixture.root, 'e2e'), path.join(fixture.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await expect(fixture.workspace.read('linked/synthetic.spec.ts')).rejects.toThrow(/Linked|alias|reparse/u);
  await expect(fixture.workspace.inventory('public/wasm')).rejects.toThrow(/enumeration/u);
});
test('release shipping validator rejects stale source, manifest hashes, unlisted leaves and role substitution', async () => {
  const fixture = await synthetic();
  await expect(inspectShipping(new Workspace(fixture.root), fixture.request.shipping)).resolves.toBeDefined();
  await fixture.put('dist/old-junk.js', 'obsolete');
  await expect(inspectShipping(new Workspace(fixture.root), fixture.request.shipping)).rejects.toThrow(/inventory/u);
  await rm(path.join(fixture.root, 'dist/old-junk.js'));
  await fixture.put('src/main.tsx', 'changed source');
  await expect(inspectShipping(new Workspace(fixture.root), fixture.request.shipping)).rejects.toThrow(/mismatch/u);
});
test('release shipping binds every reviewed public source to its actual deployed bytes despite a self-consistent manifest', async () => {
  const accepted = await synthetic({ publicAssetMismatch: false });
  await expect(inspectShipping(new Workspace(accepted.root), accepted.request.shipping)).resolves.toBeDefined();
  const stale = await synthetic({ publicAssetMismatch: true });
  await expect(inspectShipping(new Workspace(stale.root), stale.request.shipping)).rejects.toThrow(/Reviewed public source differs/u);
  const result = await stale.run(); expect(result.valid).toBe(false); expect(result.acceptedCells).toEqual([]);
});
test('release fixture-bearing packets reject an absent externally pinned applicability policy', async () => {
  const fixture = await synthetic();
  const manifest = JSON.parse(await readFile(path.join(fixture.root, 'dist/build-manifest.json'), 'utf8')) as ReturnType<typeof createDeploymentManifest>;
  const variants: Record<string, unknown> = {};
  for (const label of ['A', 'B', 'C']) {
    const dist = `.build/foreign-fixtures/${label}/dist`;
    const inventory: FileRef[] = [];
    for (const original of fixture.request.shipping.distribution.filter(row => row.path !== 'dist/build-manifest.json')) {
      const suffix = original.path.slice('dist/'.length);
      const value = suffix === 'index.html' ? `<title>Synthetic foreign ${label}</title>` : await readFile(path.join(fixture.root, original.path), 'utf8');
      const reference = await fixture.put(`${dist}/${suffix}`, value); inventory.push({ ...reference, path: suffix });
    }
    const records = inventory.filter(row => !row.path.endsWith('.map'));
    const deployment = createDeploymentManifest(manifest.build, records, 'assets/app.js', 'assets/worker.js');
    const manifestRef = await fixture.putJson(`${dist}/build-manifest.json`, deployment);
    inventory.push({ ...manifestRef, path: 'build-manifest.json' });
    variants[label] = { dist, manifest: manifestRef, build: deployment.build, deploymentId: deployment.deploymentId, inventory,
      // Deliberately foreign/unbound metadata: all physical router bytes are actually equal.
      serviceWorker: { sha256: label === 'C' ? 'c'.repeat(64) : 'a'.repeat(64) } };
  }
  const foreign = { sha256: digest('foreign source'), files: 0, bytes: 0, inventory: [] };
  const payload = { schemaVersion: 1, kind: 'genuine-offline-application-fixture-set', sourceCapture: { initial: foreign, final: foreign }, shippingNativePublication: [], fixtures: variants };
  const receipt = await fixture.putJson('.build/foreign-fixtures/fixture-set.json', { ...payload, fixtureSetId: digest(canonicalJson(payload)) });
  const evidence = fixture.request.evidence[0]!; if (evidence.kind === 'playwright') evidence.fixtureSet = receipt;
  const result = await fixture.run(); expect(result.valid).toBe(false); expect(result.boundedAccepted).toBe(false);
  expect(result.acceptedCells).toEqual([]); expect(result.evidence[0]!.qualified).toBe(false);
  expect(result.issues.join(' ')).toContain('explicit applicability policy');
});
test('release validator refuses swapped report bytes despite a green terminal summary', async () => {
  const fixture = await synthetic(); fixture.terminal.report = await fixture.putJson('.build/other-report.json', fixture.report);
  const item = fixture.request.evidence[0]!; if (item.kind === 'playwright') item.terminal = await fixture.putJson('.build/terminal.json', fixture.terminal);
  const result = await fixture.run(); expect(result.valid).toBe(false); expect(result.issues.join(' ')).toContain('external expected report');
});
test.each(['--output=.build/foreign-output', '--output=.build/output --output=.build/output'])('release validator rejects actual command output mismatch %s', value => {
  if (value.includes(' ')) expect(() => argumentOption(value.split(' '), '--output')).toThrow(/Repeated/u);
  else expect(argumentOption([value], '--output')).toBe('.build/foreign-output');
});
test('release validator compares report configured outputDir with terminal command ownership', async () => {
  const fixture = await synthetic(); fixture.report.config.projects[0]!.outputDir = path.join(fixture.root, '.build/foreign');
  const reference = await fixture.putJson('.build/report.json', fixture.report); fixture.inventory.suites[0]!.report = reference; fixture.terminal.report = reference;
  fixture.request.expectedInventory = await fixture.putJson('.build/inventory.json', fixture.inventory);
  const item = fixture.request.evidence[0]!; if (item.kind === 'playwright') item.terminal = await fixture.putJson('.build/terminal.json', fixture.terminal);
  const result = await fixture.run(); expect(result.valid).toBe(false); expect(result.issues.join(' ')).toMatch(/output/u);
});
test('release validator rejects extra output leaves even when last-run passed', async () => {
  const fixture = await synthetic(); await fixture.put('.build/output/unlisted.txt', 'unreviewed');
  const result = await fixture.run(); expect(result.valid).toBe(false); expect(result.issues.join(' ')).toMatch(/output inventory/u);
});
test('release validator cannot self-authorize unrelated or missing ledger cases', async () => {
  const fixture = await synthetic(); fixture.request.bindings[0]!.caseIds = [];
  const result = await fixture.run(); expect(result.valid).toBe(false); expect(result.issues.join(' ')).toContain('external ledger');
});
test('release validator leaves a declared empty case inventory pending rather than treating it vacuously accepted', async () => {
  const fixture = await synthetic(); fixture.ledger.capabilities[0]!.requiredCells[0]!.requiredCaseIds = [];
  fixture.request.ledger = await fixture.putJson('.build/ledger.json', fixture.ledger); fixture.request.bindings[0]!.caseIds = [];
  const result = await fixture.run(); expect(result.valid).toBe(true); expect(result.boundedAccepted).toBe(false); expect(result.acceptedCells).toEqual([]);
});
test('release validator rejects fabricated operating-budget and unsupported configuration claims', async () => {
  const fixture = await synthetic(); fixture.request.claims.budgets = [{ id: 'invented', benchmarkEvidenceId: 'synthetic-browser', cellId: 'synthetic-cell', maximumSceneRecords: 1_000_000 }];
  expect((await fixture.run()).valid).toBe(false); fixture.request.claims.budgets = []; fixture.request.claims.configurations = ['unobserved-host'];
  expect((await fixture.run()).valid).toBe(false);
});
test('release validator keeps partial implementations pending even with passing required cases', async () => {
  const fixture = await synthetic(); fixture.ledger.capabilities[0]!.implementation = 'partial';
  fixture.ledger.capabilityInventory = await fixture.put('docs/capabilities.csv', 'id,desktop_feature,scope,implementation,required_cells,exclusion_reason\nsynthetic-feature,Synthetic feature,retained,partial,synthetic-cell,\n');
  fixture.request.ledger = await fixture.putJson('.build/ledger.json', fixture.ledger);
  const result = await fixture.run(); expect(result.valid).toBe(true); expect(result.boundedAccepted).toBe(false); expect(result.pending[0]).toContain('incomplete');
});
test('release CSV parser preserves quoted multiline fields and rejects malformed quoting/rows', () => {
  expect(parseCsv('id,name\r\na,"line1\nline2, ""quoted"""\r\n')).toEqual([['id', 'name'], ['a', 'line1\nline2, "quoted"']]);
  expect(() => parseCsv('a,b\n"open,b\n')).toThrow(/Unterminated/u);
  expect(() => parseCsv('a,b\n"closed"extra,b\n')).toThrow();
  expect(() => parseCsv('a,b\nx\n')).toThrow(/width/u);
});
