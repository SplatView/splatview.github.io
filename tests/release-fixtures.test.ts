import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { canonicalJson, collectApplicationInputs, createDeploymentManifest, descriptorFromInputs } from '../tools/web-build.mjs';
import { digest, Workspace } from '../tools/release/files.ts';
import { assertSourceInventory, collectFixtureSource, inspectFixtureCaseAttachments, inspectGenuineFixtures } from '../tools/release/fixtures.ts';
import type { FixtureInspection } from '../tools/release/fixtures.ts';
import type { FileRef, FixtureApplicability, ReportExpectation, SourceCapture, TestEvidence } from '../tools/release/types.ts';

// All constructed packets are synthetic policy fixtures. No command/build/browser is executed.
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const NATIVE = ['splatview-core.mjs', 'splatview-core.wasm', 'splatview-camera.mjs', 'splatview-camera.wasm', 'build-provenance.json'];
const BEFORE = '<title>SplatView offline unavailable</title>', AFTER = '<title>SplatView offline cache unavailable</title>';
const summary = (row: FileRef) => ({ bytes: row.bytes, sha256: row.sha256 });
type Row = Record<string, unknown>;
async function synthetic() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'splatview-fixture-policy-'))); roots.push(root);
  const put = async (name: string, value: string | Uint8Array): Promise<FileRef> => {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true }); const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
    await writeFile(path.join(root, name), bytes); return { path: name, bytes: bytes.length, sha256: digest(bytes) };
  };
  const putJson = (name: string, value: unknown) => put(name, JSON.stringify(value, null, 2) + '\n');
  for (const tree of ['src', 'e2e', 'tests', 'tools', 'native/wasm', 'native/deps', 'native/upstream/splatview', 'reference/windows', 'public/wasm']) await mkdir(path.join(root, tree), { recursive: true });
  for (const name of ['index.html', 'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', 'config/playwright.config.ts', 'config/playwright.compat.config.ts', 'native/SOURCE_LOCK.json', 'native/DEPENDENCIES.json', 'native/TOOLCHAIN_LOCK.json', 'tools/web-build.mjs', 'tools/web-build.d.mts', 'tools/capture-sources.py', 'tools/generate-assets.py', 'tools/generate-native-translations.py', 'tools/build-offline-fixtures.py', 'tools/build-compat-fixtures.py', 'tools/verify-toolchain.py', 'tools/offline-test-host.mjs', 'config/playwright.offline.config.ts', 'tests/offline/offline.spec.ts']) await put(name, 'synthetic frozen source\n');
  // The real captured trees contain leaves; the generator stages files only.
  // Give every otherwise-empty required tree a leaf so staging reproduces it.
  for (const name of ['contracts/synthetic-fixture.json', 'design/feature-reviews/synthetic-fixture.md', 'e2e/synthetic-fixture.ts', 'native/deps/synthetic-fixture.txt', 'native/upstream/splatview/synthetic-fixture.txt', 'reference/windows/synthetic-fixture.txt']) await put(name, 'synthetic captured tree leaf\n');
  await put('src/main.tsx', 'synthetic main();\n'); await put('src/offline/cohortStore.ts', `const fallback = '${BEFORE}';\n`);
  await put('public/icon.svg', '<svg>synthetic reviewed bytes</svg>'); await putJson('tools/public-assets.json', { schemaVersion: 1, files: ['icon.svg'] });
  const contract = { schemaVersion: 1, protocolVersion: 1, uiWorkerContract: 1, core: { schemaVersion: 1, kind: 'core', abi: 1, variant: 'scalar', mapLayoutVersion: 1, capabilities: {} }, camera: { schemaVersion: 1, kind: 'camera', abi: 1, variant: 'scalar', capabilities: {} } };
  await putJson('native/wasm/runtime-contract.json', contract);
  const native: FileRef[] = []; for (const name of NATIVE.slice(0, 4)) native.push(await put('public/wasm/' + name, 'synthetic ' + name));
  const nativeInputId = 'a'.repeat(64);
  const provenance = { schemaVersion: 1, nativeInputId, nativeIdentity: { core: { ...contract.core, nativeInputId }, camera: { ...contract.camera, nativeInputId } }, outputs: Object.fromEntries(native.map(row => [path.posix.basename(row.path), summary(row)])) };
  native.push(await putJson('public/wasm/build-provenance.json', provenance));
  const supplement = await putJson('reference/targets/synthetic/CAPTURE_MANIFEST.json', { synthetic: true });
  const supplements = [supplement]; const authorities = await Promise.all(['tools/capture-sources.py', 'tools/generate-assets.py', 'tools/generate-native-translations.py'].map(async name => ({ path: name, ...summary((await new Workspace(root).read(name)).reference) })));
  const initial = await collectFixtureSource(new Workspace(root), supplements.map(row => row.path));
  const descriptor = descriptorFromInputs(collectApplicationInputs(root), contract, provenance);
  const generated = await put('src/generated/buildIdentity.ts', 'export const BUILD_DESCRIPTOR: BuildDescriptor = ' + JSON.stringify(descriptor, null, 2) + ';\n');
  async function deployment(stage: string, build: typeof descriptor, label: string) {
    const dist = stage ? stage + '/dist' : 'dist'; const inventory: FileRef[] = [];
    const emit = async (name: string, value: string | Uint8Array) => { const reference = await put(dist + '/' + name, value); inventory.push({ ...reference, path: name }); };
    await emit('index.html', `<title>Synthetic ${label}</title>`);
    for (const name of ['assets/app.js', 'assets/worker.js', 'service-worker.js']) await emit(name, `// synthetic ${name === 'service-worker.js' ? (label === 'C' ? AFTER : BEFORE) : label}\n//# sourceMappingURL=${path.posix.basename(name)}.map\n`);
    await emit('icon.svg', '<svg>synthetic reviewed bytes</svg>');
    for (const row of native) await emit('wasm/' + path.posix.basename(row.path), await readFile(path.join(root, row.path)));
    const manifest = createDeploymentManifest(build, inventory, 'assets/app.js', 'assets/worker.js');
    const manifestRef = await putJson(dist + '/build-manifest.json', manifest); inventory.push({ ...manifestRef, path: 'build-manifest.json' });
    for (const name of ['assets/app.js', 'assets/worker.js', 'service-worker.js']) { const reference = await putJson(dist + '/' + name + '.map', { version: 3, file: path.posix.basename(name), sources: [], mappings: '' }); inventory.push({ ...reference, path: name + '.map' }); }
    return { dist, inventory, manifest, manifestRef };
  }
  const shippingOutput = await deployment('', descriptor, 'shipping');
  const spec = initial.inventory.find(row => row.path === 'tests/offline/offline.spec.ts')!;
  const shipping: SourceCapture = { schemaVersion: 1, kind: 'splatview-release-source-capture', appInputId: descriptor.appInputId, deploymentId: shippingOutput.manifest.deploymentId, applicationInputs: collectApplicationInputs(root), nativeFiles: native, distribution: shippingOutput.inventory.map(row => ({ ...row, path: 'dist/' + row.path })), coveredInputs: [spec, generated] };
  const observedSourceCapture = await putJson('.build/observed.json', shipping);
  const node = await put('.tools/node.bin', 'synthetic node'), npm = await put('.tools/npm-cli.js', 'synthetic npm'), python = await put('.tools/python-copy.bin', 'synthetic python'), lock = await put('node_modules/.package-lock.json', 'synthetic installed lock');
  const tools = { node: { recordedPath: path.join(root, node.path), artifact: node }, npm: { recordedPath: path.join(root, npm.path), artifact: npm }, python: { recordedPath: path.join(tmpdir(), 'synthetic-external-python.exe'), artifact: python } };
  const base = '.build/offline-tests/synthetic';
  const commands: Row[] = [];
  for (let index = 0; index < 4; index++) {
    const label = index === 0 ? 'shipping-native-freshness' : `${'ABC'[index - 1]}-npm-build`;
    commands.push({ label, argv: index === 0 ? [tools.python.recordedPath, path.join(root, 'tools/verify-toolchain.py'), 'verify-build'] : [tools.node.recordedPath, tools.npm.recordedPath, 'run', 'build'], cwd: index === 0 ? '.' : `${base}/${'ABC'[index - 1]}`, exitCode: 0, log: await put(`${base}/logs/${String(index + 1).padStart(2, '0')}-${label}.log`, 'synthetic command log; never executed\n') });
  }
  const variants: Row = {};
  for (const label of ['A', 'B', 'C']) {
    const stage = base + '/' + label;
    for (const row of initial.inventory) await put(stage + '/' + row.path, await readFile(path.join(root, row.path)));
    const patches: Row[] = [], changes: Row[] = [];
    for (const name of label === 'C' ? ['src/main.tsx', 'src/offline/cohortStore.ts'] : ['src/main.tsx']) {
      const before = initial.inventory.find(row => row.path === name)!; const original = await readFile(path.join(root, name), 'utf8');
      const after = await put(stage + '/' + name, name === 'src/main.tsx' ? `// Offline cohort fixture ${label}.\n` + original : original.replace(BEFORE, AFTER));
      changes.push({ path: name, before: summary(before), after: summary(after) });
      patches.push({ sourcePath: name, path: after.path, description: name === 'src/main.tsx' ? `// Offline cohort fixture ${label}.` : 'Fixture-only compatible generic-router update: change only the fallback HTML document title', ...(name === 'src/main.tsx' ? {} : { replacement: { before: BEFORE, after: AFTER, occurrences: 1 } }), before: summary(before), after: summary(after) });
    }
    const inputs = await collectFixtureSource(new Workspace(root), supplements.map(row => row.path), { prefix: stage, withNative: false });
    const build = descriptorFromInputs(collectApplicationInputs(path.join(root, stage)), contract, provenance);
    await put(stage + '/src/generated/buildIdentity.ts', 'export const BUILD_DESCRIPTOR: BuildDescriptor = ' + JSON.stringify(build, null, 2) + ';\n');
    const output = await deployment(stage, build, label);
    variants[label] = { root: stage, dist: output.dist, variant: label === 'C' ? 'ui-and-compatible-offline-error-title' : 'ui-input', inputs, patches, sourceDifferences: changes, build, deploymentId: output.manifest.deploymentId, manifest: output.manifestRef, inventory: output.inventory, serviceWorker: output.manifest.artifacts.find(row => row.path === 'service-worker.js'), nativeMode: 'reused', nativePublication: native.map(row => ({ name: path.posix.basename(row.path), path: stage + '/' + row.path, ...summary(row) })), reviewedOverrideProvenance: supplements.map(row => ({ before: row, after: { path: stage + '/' + row.path, ...summary(row) } })), acceptanceConfiguration: [initial.inventory.find(row => row.path === 'config/playwright.offline.config.ts')!].map(row => ({ before: row, after: { path: stage + '/' + row.path, ...summary(row) } })), command: commands['ABC'.indexOf(label) + 1] };
  }
  const fixturePayload: Row = { schemaVersion: 1, kind: 'genuine-offline-application-fixture-set', captureId: 'synthetic', qualification: 'Synthetic policy fixture only; no real builds', routerRelationships: { sha256: Object.fromEntries(Object.entries(variants).map(([label, variant]) => [label, ((variant as Row).serviceWorker as Row).sha256])), aAndBIdentical: true, cDiffersFromAAndB: true, perApplicationIdentityEmbedded: false, closureQualification: 'Synthetic closure consistency only' }, sourceCapture: { initial, final: initial, additionalRootFiles: ['config/playwright.offline.config.ts'] }, reviewedOverrideProvenance: { authorities, scope: 'Synthetic exact supplemental leaf', initial: supplements, final: supplements }, tools: { ...Object.fromEntries(Object.entries(tools).map(([name, tool]) => [name, { path: tool.recordedPath, ...summary(tool.artifact) }])), sharedDependencyLock: lock, dependencyResolution: 'Canonical workspace ancestor node_modules; no junction or installation created' }, shippingNativePublication: native.map(row => ({ name: path.posix.basename(row.path), ...row })), commands, fixtures: variants };
  let receipt = { ...fixturePayload, fixtureSetId: digest(canonicalJson(fixturePayload)) };
  const receiptRef = await putJson(base + '/fixture-set.json', receipt);
  const currentSourceInventory = await putJson('.build/current-source.json', initial);
  const policy: FixtureApplicability = { schemaVersion: 1, kind: 'splatview-offline-fixture-applicability', fixtureSet: receiptRef, observedSourceCapture, currentSourceInventory, coveredInputs: initial.inventory, differences: [], tools, hostOrigin: 'http://127.0.0.1:5373', review: { identity: 'synthetic-policy', atUtc: '2026-10-15T00:00:00Z', reason: 'Synthetic validator fixture; no human release approval or actual build' } };
  const policyRef = await putJson('.build/fixture-policy.json', policy);
  const expectation: ReportExpectation = { id: 'synthetic', adapter: 'playwright', command: { executable: node, arguments: [], workingDirectory: '.' }, report: { path: '.build/not-executed.json', bytes: 0, sha256: digest('') }, coveredInputs: [spec], files: [{ path: spec.path, leaves: [{ id: 'synthetic-case', title: 'Synthetic case', project: '' }] }], outputDirectory: '.build/output', outputFiles: [], requiredAttachments: [] };
  const evidence: TestEvidence = { id: 'synthetic', kind: 'playwright', terminal: { path: '.build/not-executed-terminal.json', bytes: 0, sha256: digest('') }, expectationId: 'synthetic', fixtureSet: receiptRef, fixtureApplicability: policyRef, applicability: { kind: 'exact', observedAppInputId: descriptor.appInputId, observedDeploymentId: shipping.deploymentId, observedSourceCapture, coveredInputs: [spec], review: null } };
  const context = { evidence, expectation, shipping, descriptor };
  const reseal = async () => { receipt = { ...fixturePayload, fixtureSetId: digest(canonicalJson(fixturePayload)) }; policy.fixtureSet = await putJson(base + '/fixture-set.json', receipt); evidence.fixtureSet = policy.fixtureSet; evidence.fixtureApplicability = await putJson('.build/fixture-policy.json', policy); };
  return { root, put, putJson, initial, fixturePayload, variants, commands, policy, context, reseal, run: () => inspectGenuineFixtures(new Workspace(root), policy.fixtureSet, evidence.fixtureApplicability!, context) };
}

test('genuine fixture adapter binds exact staged sources/native/patches/commands and physical routers', async () => {
  const fixture = await synthetic(); const result = await fixture.run();
  expect(result.variants.A!.manifest.build.native).toEqual(result.variants.C!.manifest.build.native);
  expect(result.variants.A!.router.sha256).toBe(result.variants.B!.router.sha256); expect(result.variants.C!.router.sha256).not.toBe(result.variants.A!.router.sha256);
  expect(new Set(Object.values(result.variants).map(row => row.manifest.build.appInputId)).size).toBe(3);
});
test.each(['bytes', 'files', 'sha256'])('genuine fixture inventory rejects forged %s summary', async key => {
  const fixture = await synthetic(); const raw = structuredClone(fixture.initial) as unknown as Row; raw[key] = key === 'sha256' ? '0'.repeat(64) : 0;
  expect(() => assertSourceInventory(raw)).toThrow(/digest/u);
});
test('genuine fixture adapter rejects mixed receipt policy and source capture identities', async () => {
  const fixture = await synthetic(); fixture.policy.fixtureSet = { ...fixture.policy.fixtureSet, sha256: '0'.repeat(64) };
  fixture.context.evidence.fixtureApplicability = await fixture.putJson('.build/fixture-policy.json', fixture.policy);
  await expect(fixture.run()).rejects.toThrow(/hash mismatch|different receipt/u);
});
test.each(['missing-patch', 'foreign-patch', 'router-metadata', 'native', 'command-argv', 'command-outcome', 'command-cwd', 'source-capture'])('genuine fixture adapter rejects self-consistently resealed %s deception', async kind => {
  const fixture = await synthetic(); const a = fixture.variants.A as Row, c = fixture.variants.C as Row;
  if (kind === 'missing-patch') (c.patches as Row[]).pop();
  if (kind === 'foreign-patch') { (a.sourceDifferences as Row[]).push({ path: 'src/unreviewed.ts', before: { bytes: 0, sha256: digest('') }, after: { bytes: 0, sha256: digest('') } }); }
  if (kind === 'router-metadata') (c.serviceWorker as Row).sha256 = (a.serviceWorker as Row).sha256;
  if (kind === 'native') ((a.nativePublication as Row[])[0]!).sha256 = '0'.repeat(64);
  if (kind === 'command-argv') (fixture.commands[1]!.argv as string[])[2] = 'install';
  if (kind === 'command-outcome') fixture.commands[0]!.exitCode = 1;
  if (kind === 'command-cwd') fixture.commands[1]!.cwd = '.build/other';
  if (kind === 'source-capture') ((fixture.fixturePayload.sourceCapture as Row).final as Row).sha256 = '0'.repeat(64);
  await fixture.reseal(); await expect(fixture.run()).rejects.toThrow();
});
test('genuine fixture adapter rejects changed staged bytes even if top receipt inventory is untouched', async () => {
  const fixture = await synthetic(); await fixture.put('.build/offline-tests/synthetic/B/src/main.tsx', '// changed outside captured patch');
  await expect(fixture.run()).rejects.toThrow(/Staged fixture source inventory/u);
});
test('genuine fixture adapter rejects stale current inventory and omitted covered runtime source', async () => {
  const fixture = await synthetic(); await fixture.put('src/main.tsx', 'new behavior'); await expect(fixture.run()).rejects.toThrow(/Current fixture source inventory/u);
  const other = await synthetic(); other.policy.coveredInputs = other.policy.coveredInputs.filter(row => row.path !== 'src/main.tsx');
  await other.reseal(); await expect(other.run()).rejects.toThrow(/omits protected/u);
});
test('genuine fixture source capture refuses an uncaptured browser configuration', async () => {
  const fixture = await synthetic();
  await fixture.put('config/playwright.unreviewed.config.ts', '// uncaptured browser configuration');
  await expect(fixture.run()).rejects.toThrow(/Current fixture source inventory/u);
});
test('genuine fixture adapter requires exact attributed review for additions outside protected inputs', async () => {
  const fixture = await synthetic(); const addition = await fixture.put('tools/release/new-unexecuted.ts', '// synthetic new validator tooling');
  const current = await collectFixtureSource(new Workspace(fixture.root), ['reference/targets/synthetic/CAPTURE_MANIFEST.json']);
  fixture.policy.currentSourceInventory = await fixture.putJson('.build/current-source.json', current);
  await fixture.reseal(); await expect(fixture.run()).rejects.toThrow(/explicit applicability review/u);
  fixture.policy.differences = [{ path: addition.path, before: null, after: summary(addition), reason: 'New tooling was not an input of the sealed fixture builds or covered browser workflow' }];
  await fixture.reseal(); await expect(fixture.run()).resolves.toBeDefined();
});
function casePacket(fixture: FixtureInspection) {
  const encode = (name: string, value: unknown) => { const bytes = Buffer.from(JSON.stringify(value)); return { name, contentType: 'application/json', body: bytes.toString('base64'), sha256: digest(bytes) }; };
  const input = encode('genuine-fixture-inputs', { receipt: fixture.reference, fixtureSetId: fixture.value.fixtureSetId, fixtures: fixture.value.fixtures, sourceCapture: fixture.value.sourceCapture, shippingNativePublication: fixture.value.shippingNativePublication, routerRelationships: fixture.value.routerRelationships });
  const owner = { pages: [], host: { schemaVersion: 1, kind: 'splatview-offline-fixture-host', origin: fixture.policy.hostOrigin, pid: 1234, countersDropped: 0, counters: [], faults: [], selected: { root: 'A', project: 'A' }, cohorts: Object.fromEntries(Object.entries(fixture.variants).map(([id, variant]) => [id, { id, directory: path.resolve(variant.root, '..', 'dist'), deploymentId: variant.manifest.deploymentId, appInputId: variant.manifest.build.appInputId, coreNativeInputId: variant.manifest.build.native.core.nativeInputId, serviceWorkerSha256: variant.router.sha256, manifestSha256: variant.manifestRef.sha256, runtimeArtifacts: variant.manifest.artifacts.length, files: variant.files }])) } };
  return { input, owner, encode };
}
test('genuine fixture case proofs reject missing ownership requirements and foreign actual host cohorts', async () => {
  const fixture = await synthetic(), inspected = await fixture.run(); const packet = casePacket(inspected);
  for (const [id, variant] of Object.entries(inspected.variants)) packet.owner.host.cohorts[id]!.directory = path.join(fixture.root, variant.dist);
  const ownership = packet.encode('browser-ownership-and-cache-evidence', packet.owner);
  const report = { suites: [{ specs: [{ id: 'synthetic-case', tests: [{ projectName: '', results: [{ attachments: [packet.input, ownership] }] }] }] }] };
  fixture.context.expectation.requiredAttachments = [{ caseId: 'synthetic-case', project: '', name: 'genuine-fixture-inputs', sha256: packet.input.sha256, fixtureSetId: inspected.value.fixtureSetId as string }];
  await expect(inspectFixtureCaseAttachments(new Workspace(fixture.root), report, fixture.context.expectation, inspected)).rejects.toThrow(/externally pinned/u);
  fixture.context.expectation.requiredAttachments.push({ caseId: 'synthetic-case', project: '', name: 'browser-ownership-and-cache-evidence', sha256: ownership.sha256, fixtureSetId: null });
  await expect(inspectFixtureCaseAttachments(new Workspace(fixture.root), report, fixture.context.expectation, inspected)).resolves.toBeUndefined();
  packet.owner.host.cohorts.A!.deploymentId = '0'.repeat(64); report.suites[0]!.specs[0]!.tests[0]!.results[0]!.attachments[1] = packet.encode('browser-ownership-and-cache-evidence', packet.owner);
  await expect(inspectFixtureCaseAttachments(new Workspace(fixture.root), report, fixture.context.expectation, inspected)).rejects.toThrow(/foreign fixture cohort/u);
});
