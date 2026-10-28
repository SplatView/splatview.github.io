import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson, collectApplicationInputs, createDeploymentManifest, descriptorFromInputs } from '../web-build.mjs';
import { digest, relativePath, uniquePaths, Workspace } from './files.ts';
import { assertShape } from './schema.ts';
import { sameRecords } from './shipping.ts';
import type { BuildDescriptor, RuntimeManifest } from '../../src/build/contracts.ts';
import type { FileRef, FixtureApplicability, ReportExpectation, SourceCapture, SourceInventory, TestEvidence } from './types.ts';

const ROOT_FILES = ['index.html', 'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', 'config/playwright.config.ts', 'config/playwright.compat.config.ts', 'native/SOURCE_LOCK.json', 'native/DEPENDENCIES.json', 'native/TOOLCHAIN_LOCK.json'];
const TREES = ['config', 'contracts', 'design/feature-reviews', 'src', 'e2e', 'tests', 'tools', 'native/wasm', 'native/deps', 'native/upstream/splatview', 'reference/windows', 'public'];
const NATIVE = ['splatview-core.mjs', 'splatview-core.wasm', 'splatview-camera.mjs', 'splatview-camera.wasm', 'build-provenance.json'];
const AUTHORITIES = ['tools/capture-sources.py', 'tools/generate-assets.py', 'tools/generate-native-translations.py'];
const PROTECTED = [...AUTHORITIES, 'tools/build-offline-fixtures.py', 'tools/build-compat-fixtures.py', 'tools/verify-toolchain.py', 'tools/offline-test-host.mjs', 'config/playwright.offline.config.ts', 'tests/offline/offline.spec.ts'];
const BEFORE = '<title>SplatView offline unavailable</title>', AFTER = '<title>SplatView offline cache unavailable</title>';
const C_DESCRIPTION = 'Fixture-only compatible generic-router update: change only the fallback HTML document title';
type Row = Record<string, unknown>;
const object = (value: unknown): value is Row => value !== null && typeof value === 'object' && !Array.isArray(value);
const require = (value: unknown, message: string): void => { if (!value) throw new Error(message); };
const equal = (left: unknown, right: unknown): boolean => canonicalJson(left) === canonicalJson(right);
const summary = (row: FileRef): { bytes: number; sha256: string } => ({ bytes: row.bytes, sha256: row.sha256 });
const keys = (row: Row, wanted: string[]): void => require(Object.keys(row).sort().join('|') === [...wanted].sort().join('|'), 'Unexpected fixture record fields');
const text = (bytes: Uint8Array): string => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
function records(value: unknown, label: string): FileRef[] {
  require(Array.isArray(value), label + ' inventory missing');
  const rows = value as FileRef[];
  for (const row of rows) require(object(row) && Object.keys(row).sort().join('|') === 'bytes|path|sha256' && typeof row.path === 'string' && Number.isSafeInteger(row.bytes) && row.bytes >= 0 && /^[0-9a-f]{64}$/u.test(row.sha256), label + ' malformed inventory row');
  uniquePaths(rows, label); return rows;
}
export function assertSourceInventory(value: unknown): asserts value is SourceInventory {
  require(object(value), 'Source inventory missing'); const row = value as Row; keys(row, ['sha256', 'files', 'bytes', 'inventory']);
  const inventory = records(row.inventory, 'source');
  require(equal(inventory.map(item => item.path), inventory.map(item => item.path).sort()) && row.files === inventory.length && row.bytes === inventory.reduce((total, item) => total + item.bytes, 0) && row.sha256 === digest(canonicalJson(inventory)), 'Source inventory digest/count/order/bytes differs');
}
/** Exact source-universe contract of build-offline-fixtures.py; never enumerate any public/wasm directory. */
export async function collectFixtureSource(workspace: Workspace, supplementPaths: readonly string[], options: { prefix?: string; withNative?: boolean } = {}): Promise<SourceInventory> {
  const prefix = options.prefix ? relativePath(options.prefix) + '/' : '';
  const names = new Set<string>();
  const walk = async (name: string): Promise<void> => {
    if (name === 'public/wasm' || name.startsWith('public/wasm/') || name === 'src/generated/buildIdentity.ts' || name.split('/').some(part => ['__pycache__', '.git', 'node_modules'].includes(part))) return;
    const absolute = await workspace.safe(prefix + name), info = await lstat(absolute);
    if (info.isDirectory()) {
      const entries = await readdir(absolute); const folded = new Set<string>();
      for (const entry of entries.sort()) { require(!folded.has(entry.toLowerCase()), 'Case-aliased fixture source'); folded.add(entry.toLowerCase()); await walk(name + '/' + entry); }
    } else { require(info.isFile(), 'Nonregular fixture source'); names.add(name); }
  };
  for (const name of ROOT_FILES) names.add(name);
  for (const tree of TREES) await walk(tree);
  for (const name of [...supplementPaths, 'config/playwright.offline.config.ts']) names.add(relativePath(name));
  if (options.withNative ?? true) for (const name of NATIVE) names.add('public/wasm/' + name);
  const inventory: FileRef[] = [];
  for (const name of [...names].sort()) { const reference = (await workspace.read(prefix + name)).reference; inventory.push({ ...reference, path: name }); }
  return { sha256: digest(canonicalJson(inventory)), files: inventory.length, bytes: inventory.reduce((total, row) => total + row.bytes, 0), inventory };
}
function differences(before: readonly FileRef[], after: readonly FileRef[]): { path: string; before: ReturnType<typeof summary> | null; after: ReturnType<typeof summary> | null }[] {
  const first = new Map(before.map(row => [row.path, row])), last = new Map(after.map(row => [row.path, row]));
  return [...new Set([...first.keys(), ...last.keys()])].sort().flatMap(name => { const a = first.get(name), b = last.get(name); return equal(a ? summary(a) : null, b ? summary(b) : null) ? [] : [{ path: name, before: a ? summary(a) : null, after: b ? summary(b) : null }]; });
}
export interface FixtureInspection { reference: FileRef; value: Row; references: FileRef[]; policy: FixtureApplicability; variants: Record<string, { root: string; dist: string; manifest: RuntimeManifest; manifestRef: FileRef; router: FileRef; files: number }> }

export async function inspectGenuineFixtures(workspace: Workspace, receiptRef: FileRef, policyRef: FileRef, context: { evidence: TestEvidence; expectation: ReportExpectation; shipping: SourceCapture; descriptor: BuildDescriptor }): Promise<FixtureInspection> {
  const policyValue = await workspace.json(policyRef); assertShape<FixtureApplicability>('FixtureApplicability', policyValue); const policy = policyValue;
  require(equal(policy.fixtureSet, receiptRef) && equal(policy.observedSourceCapture, context.evidence.applicability.observedSourceCapture), 'Fixture policy refers to different receipt/observed capture');
  require(Number.isFinite(Date.parse(policy.review.atUtc)), 'Fixture applicability review interval invalid');
  const origin = new URL(policy.hostOrigin); require(origin.origin === policy.hostOrigin && origin.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname), 'Fixture host must be exact local observed origin; deployed HTTPS is separate');
  const receiptValue = await workspace.json(receiptRef); require(object(receiptValue), 'Fixture receipt missing'); const value = receiptValue as Row;
  keys(value, ['schemaVersion', 'kind', 'captureId', 'qualification', 'routerRelationships', 'sourceCapture', 'reviewedOverrideProvenance', 'tools', 'shippingNativePublication', 'commands', 'fixtures', 'fixtureSetId']);
  require(value.schemaVersion === 1 && value.kind === 'genuine-offline-application-fixture-set' && typeof value.captureId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/u.test(value.captureId), 'Fixture kind/capture ID differs');
  const { fixtureSetId, ...payload } = value; require(fixtureSetId === digest(canonicalJson(payload)), 'Fixture-set ID differs from receipt bytes');
  const base = `.build/offline-tests/${value.captureId as string}`;
  require(receiptRef.path === base + '/fixture-set.json', 'Fixture receipt path/capture ID scope differs');
  require(object(value.sourceCapture), 'Fixture source capture missing'); const capture = value.sourceCapture as Row;
  keys(capture, ['initial', 'final', 'additionalRootFiles']); assertSourceInventory(capture.initial); assertSourceInventory(capture.final);
  require(equal(capture.initial, capture.final) && equal(capture.additionalRootFiles, ['config/playwright.offline.config.ts']), 'Fixture source changed or additional configuration differs');
  const initial = capture.initial as SourceInventory;
  const overrides = value.reviewedOverrideProvenance as Row;
  require(object(overrides), 'Fixture provenance supplement missing'); keys(overrides, ['authorities', 'scope', 'initial', 'final']);
  const supplements = records(overrides.initial, 'supplement'); require(sameRecords(supplements, records(overrides.final, 'final supplement')), 'Fixture supplement drifted');
  require(supplements.length > 0 && supplements.every(row => row.path.startsWith('reference/targets/') && (row.path.endsWith('/CAPTURE_MANIFEST.json') || row.path.includes('/source/'))), 'Unreviewed supplemental provenance path');
  const authorities = records(overrides.authorities, 'supplement authority'); require(equal(authorities.map(row => row.path).sort(), [...AUTHORITIES].sort()), 'Fixture provenance authority membership differs');
  const policyCovered = records(policy.coveredInputs, 'policy coverage');
  const required = [...context.shipping.applicationInputs, ...context.shipping.nativeFiles, ...context.expectation.coveredInputs.filter(row => initial.inventory.some(item => item.path === row.path)), ...supplements, ...authorities];
  for (const name of PROTECTED) { const row = initial.inventory.find(item => item.path === name); require(row, 'Missing protected fixture authority: ' + name); required.push(row!); }
  for (const row of required) require(policyCovered.some(item => equal(item, row)), 'Fixture policy omits protected/covered input: ' + row.path);
  const currentValue = await workspace.json(policy.currentSourceInventory); assertSourceInventory(currentValue);
  const current = await collectFixtureSource(workspace, supplements.map(row => row.path)); require(equal(current, currentValue), 'Current fixture source inventory differs from externally bound observation');
  const observedValue = await workspace.json(policy.observedSourceCapture); assertShape<SourceCapture>('SourceCapture', observedValue);
  require(observedValue.appInputId === context.evidence.applicability.observedAppInputId && observedValue.deploymentId === context.evidence.applicability.observedDeploymentId, 'Fixture observed capture identity differs');
  const observed = [...observedValue.applicationInputs, ...observedValue.nativeFiles, ...observedValue.coveredInputs];
  for (const row of policyCovered) {
    const original = initial.inventory.find(item => item.path === row.path), actual = current.inventory.find(item => item.path === row.path);
    require(original && actual && equal(original, row) && equal(actual, row), 'Fixture covered source changed/missing: ' + row.path);
    // Explicit authority/supplement inputs are also pinned by the source receipt and policy.
    if (context.expectation.coveredInputs.some(item => item.path === row.path)) require(observed.some(item => equal(item, row)), 'Observed test capture omits fixture-covered input: ' + row.path);
  }
  const delta = differences(initial.inventory, current.inventory);
  require(equal(delta, policy.differences.map(({ path: name, before, after }) => ({ path: name, before, after }))), 'Fixture source delta differs from explicit applicability review');
  uniquePaths(policy.differences.map(row => ({ path: row.path, bytes: 0, sha256: '0'.repeat(64) })), 'fixture reviewed delta');
  require(policy.differences.every(row => row.reason.trim() && !policyCovered.some(covered => covered.path === row.path)), 'Changed fixture input is covered or lacks review rationale');
  const references: FileRef[] = [receiptRef, policyRef, policy.currentSourceInventory, policy.observedSourceCapture, ...policyCovered];
  const toolRecords = value.tools as Row; require(object(toolRecords), 'Fixture tools missing'); keys(toolRecords, ['node', 'npm', 'python', 'sharedDependencyLock', 'dependencyResolution']);
  for (const name of ['node', 'npm', 'python'] as const) {
    const declaration = policy.tools[name], original = toolRecords[name]; require(object(original), 'Fixture tool metadata missing'); keys(original as Row, ['path', 'bytes', 'sha256']);
    require(path.isAbsolute(declaration.recordedPath) && (original as Row).path === declaration.recordedPath && (original as Row).bytes === declaration.artifact.bytes && (original as Row).sha256 === declaration.artifact.sha256, 'Fixture tool identity differs: ' + name);
    await workspace.read(declaration.artifact.path, declaration.artifact); references.push(declaration.artifact);
    if (name !== 'python') require(workspace.normalize(declaration.recordedPath) === declaration.artifact.path, 'Fixture in-workspace tool path alias differs');
  }
  require(toolRecords.dependencyResolution === 'Canonical workspace ancestor node_modules; no junction or installation created', 'Fixture dependency resolution policy differs');
  const dependency = records([toolRecords.sharedDependencyLock], 'fixture dependency')[0]!; require(dependency.path === 'node_modules/.package-lock.json', 'Fixture dependency lock path differs'); await workspace.read(dependency.path, dependency); references.push(dependency);
  const native = value.shippingNativePublication as (FileRef & { name: string })[];
  require(Array.isArray(native) && native.length === 5 && equal(native.map(row => row.name), NATIVE), 'Shipping native fixture publication membership/order differs');
  for (const row of native) { require(object(row), 'Native fixture record malformed'); keys(row as unknown as Row, ['name', 'path', 'bytes', 'sha256']); require(row.path === 'public/wasm/' + row.name && context.shipping.nativeFiles.some(item => equal(item, { path: row.path, ...summary(row) })), 'Foreign fixture shipping native bytes'); }
  require(object(value.fixtures) && equal(Object.keys(value.fixtures).sort(), ['A', 'B', 'C']), 'Fixture variants missing/foreign');
  const commands = value.commands as Row[]; require(Array.isArray(commands) && commands.length === 4, 'Fixture build command inventory differs');
  for (let index = 0; index < commands.length; index++) {
    const command = commands[index]!; require(object(command), 'Fixture command missing'); keys(command, ['label', 'argv', 'cwd', 'exitCode', 'log']);
    const label = index === 0 ? 'shipping-native-freshness' : `${'ABC'[index - 1]}-npm-build`;
    const expectedArgv = index === 0 ? [policy.tools.python.recordedPath, path.join(workspace.root, 'tools/verify-toolchain.py'), 'verify-build'] : [policy.tools.node.recordedPath, policy.tools.npm.recordedPath, 'run', 'build'];
    const expectedCwd = index === 0 ? '.' : `${base}/${'ABC'[index - 1]}`;
    const log = records([command.log], 'fixture command log')[0]!;
    require(command.label === label && command.cwd === expectedCwd && command.exitCode === 0 && equal(command.argv, expectedArgv) && log?.path === `${base}/logs/${String(index + 1).padStart(2, '0')}-${label}.log`, 'Fixture command executable/argv/cwd/outcome/log scope differs');
    await workspace.read(log.path, log); references.push(log);
  }
  const variants: FixtureInspection['variants'] = {};
  const source = initial.inventory.filter(row => !row.path.startsWith('public/wasm/'));
  for (const label of ['A', 'B', 'C']) {
    const fixture = (value.fixtures as Row)[label] as Row; require(object(fixture), 'Fixture record missing');
    keys(fixture, ['root', 'dist', 'variant', 'inputs', 'patches', 'sourceDifferences', 'build', 'deploymentId', 'manifest', 'inventory', 'serviceWorker', 'nativeMode', 'nativePublication', 'reviewedOverrideProvenance', 'acceptanceConfiguration', 'command']);
    const root = `${base}/${label}`, dist = root + '/dist';
    require(fixture.root === root && fixture.dist === dist && fixture.nativeMode === 'reused' && fixture.variant === (label === 'C' ? 'ui-and-compatible-offline-error-title' : 'ui-input') && equal(fixture.command, commands['ABC'.indexOf(label) + 1]), 'Fixture stage/native mode/build command differs');
    assertSourceInventory(fixture.inputs); const inputs = fixture.inputs as SourceInventory;
    const staged = await collectFixtureSource(workspace, supplements.map(row => row.path), { prefix: root, withNative: false }); require(equal(staged, inputs), 'Staged fixture source inventory changed');
    const changes = differences(source, inputs.inventory); const patched = label === 'C' ? ['src/main.tsx', 'src/offline/cohortStore.ts'] : ['src/main.tsx'];
    require(equal(changes.map(row => row.path), patched) && changes.every(row => row.before && row.after) && equal(changes, fixture.sourceDifferences), 'Unexplained/missing fixture source patch');
    const patches = fixture.patches as Row[]; require(Array.isArray(patches) && patches.length === patched.length, 'Fixture patch inventory differs');
    for (const name of patched) {
      const patch = patches.find(row => row.sourcePath === name); require(patch && object(patch), 'Fixture patch missing');
      const difference = changes.find(row => row.path === name)!;
      const original = await workspace.read(name, initial.inventory.find(row => row.path === name));
      const actual = await workspace.read(`${root}/${name}`, { path: `${root}/${name}`, ...difference.after! });
      const comment = `// Offline cohort fixture ${label}.\n`;
      const expected = name === 'src/main.tsx' ? new TextEncoder().encode(comment + text(original.bytes)) : new TextEncoder().encode(text(original.bytes).replace(BEFORE, AFTER));
      if (name !== 'src/main.tsx') require(text(original.bytes).split(BEFORE).length === 2, 'Fixture title anchor no longer occurs exactly once');
      require(Buffer.from(expected).equals(Buffer.from(actual.bytes)) && patch!.path === `${root}/${name}` && equal(patch!.before, difference.before) && equal(patch!.after, difference.after), 'Fixture patch bytes/before/after differ');
      if (name === 'src/main.tsx') { keys(patch!, ['sourcePath', 'path', 'description', 'before', 'after']); require(patch!.description === comment.trim(), 'Fixture main comment declaration differs'); }
      else { keys(patch!, ['sourcePath', 'path', 'description', 'replacement', 'before', 'after']); require(patch!.description === C_DESCRIPTION && equal(patch!.replacement, { before: BEFORE, after: AFTER, occurrences: 1 }), 'Fixture title replacement declaration differs'); }
    }
    const stagedNative = fixture.nativePublication as (FileRef & { name: string })[]; require(Array.isArray(stagedNative) && stagedNative.length === 5, 'Fixture native publication missing');
    for (let index = 0; index < NATIVE.length; index++) {
      const row = stagedNative[index]!, original = native[index]!; require(object(row), 'Staged native record malformed'); keys(row as unknown as Row, ['name', 'path', 'bytes', 'sha256']); require(row.name === original.name && row.path === `${root}/public/wasm/${row.name}` && equal(summary(row), summary(original)), 'Foreign staged fixture native bytes'); await workspace.read(row.path, { path: row.path, ...summary(row) });
    }
    for (const [key, originals] of [['reviewedOverrideProvenance', supplements], ['acceptanceConfiguration', [initial.inventory.find(row => row.path === 'config/playwright.offline.config.ts')!]]] as const) {
      const copies = fixture[key] as Row[]; require(Array.isArray(copies) && copies.length === originals.length, 'Fixture supplemental/config copy inventory differs');
      for (const original of originals) { const copy = copies.find(row => object(row.before) && row.before.path === original.path); require(copy && equal(copy.before, original) && equal(copy.after, { path: `${root}/${original.path}`, ...summary(original) }), 'Fixture supplemental/config before/after binding differs'); keys(copy!, ['before', 'after']); await workspace.read(`${root}/${original.path}`, { path: `${root}/${original.path}`, ...summary(original) }); }
    }
    const appInputs = collectApplicationInputs(path.join(workspace.root, root));
    const contract = JSON.parse(text((await workspace.read(root + '/native/wasm/runtime-contract.json')).bytes)) as unknown;
    const provenance = JSON.parse(text((await workspace.read(root + '/public/wasm/build-provenance.json')).bytes)) as unknown;
    const descriptor = descriptorFromInputs(appInputs, contract, provenance);
    require(equal(descriptor, fixture.build) && equal(descriptor.native, context.descriptor.native) && descriptor.protocolVersion === context.descriptor.protocolVersion && descriptor.uiWorkerContract === context.descriptor.uiWorkerContract, 'Fixture app/native descriptor differs from staged inputs/applicable shipping');
    const generated = text((await workspace.read(root + '/src/generated/buildIdentity.ts')).bytes), match = /export const BUILD_DESCRIPTOR: BuildDescriptor = (\{[\s\S]*\});\s*$/u.exec(generated);
    require(match && equal(JSON.parse(match[1]!), descriptor), 'Fixture generated descriptor stale');
    const manifestRef = records([fixture.manifest], 'fixture manifest')[0]!; require(manifestRef.path === dist + '/build-manifest.json', 'Fixture manifest path differs');
    const manifest = await workspace.json(manifestRef) as RuntimeManifest;
    require(manifest && Array.isArray(manifest.artifacts) && equal(manifest.build, descriptor) && manifest.deploymentId === fixture.deploymentId, 'Fixture manifest descriptor differs');
    const entry = manifest.artifacts.find(row => row.role === 'application-entry'), worker = manifest.artifacts.find(row => row.role === 'document-worker'); require(entry && worker, 'Fixture runtime entry/worker absent');
    require(equal(createDeploymentManifest(descriptor, manifest.artifacts.map(({ path: name, bytes, sha256 }) => ({ path: name, bytes, sha256 })), entry!.path, worker!.path), manifest), 'Fixture deployment digest/roles differ');
    const inventory = records(fixture.inventory, 'fixture distribution'), actual = await workspace.inventory(dist);
    require(sameRecords(actual, inventory.map(row => ({ ...row, path: dist + '/' + row.path }))), 'Fixture complete output inventory differs');
    const allowed = new Set(['build-manifest.json', ...manifest.artifacts.map(row => row.path), entry!.path + '.map', worker!.path + '.map', 'service-worker.js.map']);
    require(inventory.length === allowed.size && inventory.every(row => allowed.has(row.path)), 'Fixture output contains stale/unknown/missing leaves');
    for (const artifact of manifest.artifacts) await workspace.read(dist + '/' + artifact.path, { path: dist + '/' + artifact.path, ...summary(artifact) });
    for (const name of [entry!.path, worker!.path, 'service-worker.js']) {
      const map = JSON.parse(text((await workspace.read(dist + '/' + name + '.map')).bytes)) as Row;
      require(map.version === 3 && map.file === path.posix.basename(name) && text((await workspace.read(dist + '/' + name)).bytes).includes('sourceMappingURL=' + path.posix.basename(name) + '.map'), 'Fixture emitted source map differs');
    }
    for (const original of [...appInputs.filter(row => row.path.startsWith('public/')), ...native.map(row => ({ path: row.path, ...summary(row) }))]) await workspace.read(dist + '/' + original.path.slice('public/'.length), { path: dist + '/' + original.path.slice('public/'.length), ...summary(original) });
    const serviceWorker = manifest.artifacts.find(row => row.path === 'service-worker.js'); require(serviceWorker?.role === 'runtime-asset' && equal(serviceWorker, fixture.serviceWorker), 'Fixture router metadata differs from actual manifest');
    const router = (await workspace.read(dist + '/service-worker.js', { path: dist + '/service-worker.js', ...summary(serviceWorker!) })).reference;
    variants[label] = { root, dist, manifest, manifestRef, router, files: inventory.length }; references.push(manifestRef, router);
  }
  require(new Set(Object.values(variants).map(row => row.manifest.deploymentId)).size === 3 && new Set(Object.values(variants).map(row => row.manifest.build.appInputId)).size === 3, 'Fixture app/deployment IDs must all be distinct');
  const routerHashes = Object.fromEntries(Object.entries(variants).map(([label, row]) => [label, row.router.sha256]));
  require(routerHashes.A === routerHashes.B && routerHashes.A !== routerHashes.C, 'Physical A/B/C router relationship differs');
  const relationships = value.routerRelationships as Row;
  require(object(relationships), 'Fixture router relationship missing'); keys(relationships, ['sha256', 'aAndBIdentical', 'cDiffersFromAAndB', 'perApplicationIdentityEmbedded', 'closureQualification']);
  require(object(relationships) && equal(relationships.sha256, routerHashes) && relationships.aAndBIdentical === true && relationships.cDiffersFromAAndB === true && relationships.perApplicationIdentityEmbedded === false, 'Fixture router relationship declaration differs');
  const appIds = [context.descriptor.appInputId, ...Object.values(variants).map(row => row.manifest.build.appInputId)];
  for (const variant of Object.values(variants)) { const router = text((await workspace.read(variant.router.path, variant.router)).bytes); require(appIds.every(id => !router.includes(id)), 'Generic fixture router embeds per-app identity'); }
  require(equal(await collectFixtureSource(workspace, supplements.map(row => row.path)), current), 'Current fixture source changed during validation');
  return { reference: receiptRef, value, references, policy, variants };
}

/** Every actual fixture-backed case must name the selected immutable receipt and observed host cohorts. */
export async function inspectFixtureCaseAttachments(workspace: Workspace, report: unknown, expectation: ReportExpectation, fixture: FixtureInspection): Promise<void> {
  const pids = new Set<number>(); let cases = 0;
  const decode = async (attachment: Row): Promise<Row> => {
    const bytes = typeof attachment.path === 'string' ? (await workspace.read(workspace.normalize(attachment.path))).bytes : Buffer.from(attachment.body as string, 'base64');
    const value: unknown = JSON.parse(text(bytes)); require(object(value), 'Fixture case attachment must be JSON object'); return value as Row;
  };
  const walk = async (suites: Row[]): Promise<void> => {
    for (const suite of suites) {
      for (const spec of (suite.specs ?? []) as Row[]) for (const test of spec.tests as Row[]) {
        cases++; const requirements = expectation.requiredAttachments.filter(row => row.caseId === spec.id && row.project === test.projectName);
        require(requirements.some(row => row.name === 'genuine-fixture-inputs' && row.fixtureSetId === fixture.value.fixtureSetId) && requirements.some(row => row.name === 'browser-ownership-and-cache-evidence' && row.sha256 !== null), 'Every fixture case requires externally pinned fixture and ownership/cache attachments');
        const attachments = ((test.results as Row[])[0]!.attachments as Row[]);
        const originals = attachments.filter(row => row.name === 'genuine-fixture-inputs'), ownership = attachments.filter(row => row.name === 'browser-ownership-and-cache-evidence');
        require(originals.length === 1 && ownership.length === 1, 'Fixture case proof attachments missing/duplicate');
        const input = await decode(originals[0]!);
        require(equal(input.routerRelationships, fixture.value.routerRelationships), 'Case router relationship differs from selected fixture set');
        const observation = await decode(ownership[0]!); const host = observation.host as Row;
        require(Array.isArray(observation.pages) && observation.pages.every(page => object(page) && !Object.hasOwn(page, 'evidenceError')), 'Fixture page observation failed');
        require(object(host) && host.schemaVersion === 1 && host.kind === 'splatview-offline-fixture-host' && host.origin === fixture.policy.hostOrigin && Number.isSafeInteger(host.pid) && (host.pid as number) > 0 && host.countersDropped === 0 && Array.isArray(host.counters) && Array.isArray(host.faults), 'Fixture host observation missing/truncated/foreign');
        pids.add(host.pid as number); require(object(host.cohorts) && equal(Object.keys(host.cohorts).sort(), ['A', 'B', 'C']), 'Fixture host cohort inventory differs');
        for (const [label, variant] of Object.entries(fixture.variants)) {
          const actual = (host.cohorts as Row)[label] as Row;
          require(object(actual) && actual.id === label && typeof actual.directory === 'string' && workspace.normalize(actual.directory) === variant.dist && actual.deploymentId === variant.manifest.deploymentId && actual.appInputId === variant.manifest.build.appInputId && actual.coreNativeInputId === variant.manifest.build.native.core.nativeInputId && actual.serviceWorkerSha256 === variant.router.sha256 && actual.manifestSha256 === variant.manifestRef.sha256 && actual.runtimeArtifacts === variant.manifest.artifacts.length && actual.files === variant.files, 'Observed host uses foreign fixture cohort: ' + label);
        }
        require(object(host.selected) && ['A', 'B', 'C'].includes((host.selected as Row).root as string) && ['A', 'B', 'C'].includes((host.selected as Row).project as string), 'Observed fixture mount selection foreign');
      }
      if (suite.suites) await walk(suite.suites as Row[]);
    }
  };
  require(object(report) && Array.isArray(report.suites), 'Fixture report suites missing'); await walk((report as Row).suites as Row[]);
  require(cases > 0 && pids.size === 1, 'Fixture case host owner missing/mixed');
}
