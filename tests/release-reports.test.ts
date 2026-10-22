import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { test } from 'vitest';
import { inspectTestReport } from '../tools/release/reports.ts';
import type { ReportInspectionContext } from '../tools/release/reports.ts';
import type { FileRef, ReportExpectation } from '../tools/release/types.ts';

// All packets below are synthetic policy fixtures; none attest a real command or release.
const H = (value: string): string => value.repeat(64);
const bytes = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
const digest = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex');
const ref = (path: string, value: Uint8Array = new Uint8Array()): FileRef => ({ path, bytes: value.byteLength, sha256: digest(value) });
function normalizePath(input: string, base?: string): string {
  const relative = (path: string): string => {
    const clean = path.replaceAll('\\', '/');
    if (clean === 'C:/repo') return '.';
    if (clean.startsWith('C:/repo/')) return clean.slice(8);
    if (clean.startsWith('/') || clean.includes(':') || clean.includes('\0')) throw new Error('External path');
    return clean;
  };
  const clean = relative(input);
  const path = posix.normalize(base === undefined || input.replaceAll('\\', '/').startsWith('C:/repo/') ? clean : posix.join(relative(base), clean));
  if (path === '..' || path.startsWith('../')) throw new Error('Escaping path');
  return path;
}
function context(files: Map<string, Uint8Array> = new Map()): ReportInspectionContext {
  return { normalizePath, readAttachment: async path => {
    const value = files.get(path);
    if (!value) throw new Error('Missing test attachment');
    return { reference: ref(path, value), bytes: value };
  } };
}
function expectation(adapter: ReportExpectation['adapter']): ReportExpectation {
  return { id: 'synthetic-report-policy', adapter,
    command: { executable: ref('.tools/node.exe'), arguments: [], workingDirectory: '.' },
    report: ref('.build/policy/report.json'), coveredInputs: [],
    files: [], outputDirectory: adapter === 'playwright' ? '.build/policy/output' : null,
    outputFiles: [], requiredAttachments: [] };
}
function cpu() {
  const wanted = expectation('vitest');
  wanted.files = [{ path: 'tests/a.test.ts', leaves: [{ id: 'outer inner case', title: 'outer inner case', project: '' }] }];
  const report = { success: true, numTotalTestSuites: 3, numPassedTestSuites: 3, numFailedTestSuites: 0, numPendingTestSuites: 0,
    numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0,
    testResults: [{ name: 'C:/repo/tests/a.test.ts', status: 'passed', message: '', assertionResults: [
      { ancestorTitles: ['outer', 'inner'], fullName: 'outer inner case', title: 'case', status: 'passed', failureMessages: [], meta: {}, releaseDiagnostics: { retryCount: 0, repeatCount: 0 } },
    ] }] };
  return { wanted, report };
}
function browser() {
  const wanted = expectation('playwright');
  wanted.files = [{ path: 'e2e/a.spec.ts', leaves: [{ id: 'case-a', title: 'actual title', project: '' }] }];
  const report = { config: { rootDir: 'C:/repo/e2e', projects: [
    { name: '', outputDir: 'C:/repo/.build/policy/output' },
    { name: 'unused-configuration', outputDir: 'C:/repo/.build/policy/output' },
  ], filteredProjects: [{ name: '', outputDir: 'C:\\repo\\.build\\policy\\output' }] },
    errors: [], stats: { expected: 1, unexpected: 0, flaky: 0, skipped: 0 },
    suites: [{ title: 'a.spec.ts', file: 'a.spec.ts', specs: [{ id: 'case-a', title: 'actual title', file: 'a.spec.ts', ok: true,
      tests: [{ projectName: '', expectedStatus: 'passed', status: 'expected', results: [{ status: 'passed', retry: 0, errors: [], attachments: [] as unknown[] }] }],
    }] }] };
  return { wanted, report };
}
type Browser = ReturnType<typeof browser>;
const result = (packet: Browser) => packet.report.suites[0]!.specs[0]!.tests[0]!.results[0]!;
const spec = (packet: Browser) => packet.report.suites[0]!.specs[0]!;
const cpuCase = (packet: ReturnType<typeof cpu>) => packet.report.testResults[0]!.assertionResults[0]!;

test('release report adapter derives Vitest file/ancestor/leaf counts and pins fullName', async () => {
  const packet = cpu(), inspected = await inspectTestReport('vitest', packet.report, packet.wanted, context());
  assert.equal(inspected.valid, true, JSON.stringify(inspected.issues));
  assert.deepEqual(inspected.pending, []);
  assert.deepEqual(inspected.leaves, [{ id: 'outer inner case', title: 'outer inner case', file: 'tests/a.test.ts', project: '', passed: true, attachments: [] }]);
  assert.deepEqual(inspected.outputDirectories, []);
});
test('release report adapter accepts default Playwright project and unused configured projects', async () => {
  const packet = browser(), inspected = await inspectTestReport('playwright', packet.report, packet.wanted, context());
  assert.equal(inspected.valid, true, JSON.stringify(inspected.issues));
  assert.deepEqual(inspected.outputDirectories, ['.build/policy/output']);
  assert.equal(inspected.leaves[0]!.title, 'actual title');
});
test('standard Vitest JSON remains consistency-valid with the no-retry proof explicitly pending', async () => {
  const p = cpu();
  const report = structuredClone(p.report) as unknown as { testResults: { assertionResults: Record<string, unknown>[] }[] };
  delete report.testResults[0]!.assertionResults[0]!.releaseDiagnostics;
  const inspected = await inspectTestReport('vitest', report, p.wanted, context());
  assert.equal(inspected.valid, true, JSON.stringify(inspected.issues));
  assert.equal(inspected.pending.length, 1); assert.match(inspected.pending[0]!, /omits observed retry\/repeat diagnostics/);
});
function runtimeCpu() {
  const packet = cpu();
  const report = { ...packet.report, releaseReporter: { schemaVersion: 1, kind: 'splatview-vitest-runtime', vitestVersion: '5.0.3', runReason: 'passed', missingDiagnostics: 0 } };
  const assertion = report.testResults[0]!.assertionResults[0]!;
  Object.assign(assertion.releaseDiagnostics, { flaky: false });
  return { wanted: packet.wanted, report };
}
test('runtime-marked Vitest reports preserve exact observed diagnostics and run identity', async () => {
  const packet = runtimeCpu();
  const inspected = await inspectTestReport('vitest', packet.report, packet.wanted, context());
  assert.equal(inspected.valid, true, JSON.stringify(inspected.issues));
  assert.deepEqual(inspected.pending, []);
});
test('runtime-marked missing diagnostics remain pending without fabricated zero observations', async () => {
  const packet = runtimeCpu();
  const report = structuredClone(packet.report) as unknown as { releaseReporter: Record<string, unknown>; testResults: { assertionResults: Record<string, unknown>[] }[] };
  delete report.testResults[0]!.assertionResults[0]!.releaseDiagnostics;
  report.releaseReporter.missingDiagnostics = 1;
  const inspected = await inspectTestReport('vitest', report, packet.wanted, context());
  assert.equal(inspected.valid, true, JSON.stringify(inspected.issues));
  assert.equal(inspected.pending.length, 1);
});
for (const [name, change] of [
  ['interrupted run', (report: Record<string, unknown>) => { (report.releaseReporter as Record<string, unknown>).runReason = 'interrupted'; }],
  ['failed run', (report: Record<string, unknown>) => { (report.releaseReporter as Record<string, unknown>).runReason = 'failed'; }],
  ['forged missing count', (report: Record<string, unknown>) => { (report.releaseReporter as Record<string, unknown>).missingDiagnostics = 1; }],
  ['foreign marker kind', (report: Record<string, unknown>) => { (report.releaseReporter as Record<string, unknown>).kind = 'json'; }],
  ['foreign marker version', (report: Record<string, unknown>) => { (report.releaseReporter as Record<string, unknown>).schemaVersion = 2; }],
  ['absent Vitest version', (report: Record<string, unknown>) => { (report.releaseReporter as Record<string, unknown>).vitestVersion = ''; }],
  ['extra marker field', (report: Record<string, unknown>) => { (report.releaseReporter as Record<string, unknown>).claim = 'passed'; }],
  ['flaky runtime diagnostic', (report: Record<string, unknown>) => { ((report.testResults as { assertionResults: { releaseDiagnostics: Record<string, unknown> }[] }[])[0]!.assertionResults[0]!.releaseDiagnostics).flaky = true; }],
  ['absent flaky observation', (report: Record<string, unknown>) => { delete ((report.testResults as { assertionResults: { releaseDiagnostics: Record<string, unknown> }[] }[])[0]!.assertionResults[0]!.releaseDiagnostics).flaky; }],
  ['invented diagnostic field', (report: Record<string, unknown>) => { ((report.testResults as { assertionResults: { releaseDiagnostics: Record<string, unknown> }[] }[])[0]!.assertionResults[0]!.releaseDiagnostics).claim = true; }],
] as const) test(`runtime-marked Vitest rejects ${name}`, async () => {
  const packet = runtimeCpu(), report = structuredClone(packet.report) as unknown as Record<string, unknown>;
  change(report);
  assert.equal((await inspectTestReport('vitest', report, packet.wanted, context())).valid, false);
});
for (const [name, change] of [
  ['unsuccessful run', (p: ReturnType<typeof cpu>) => { p.report.success = false; }],
  ['skipped assertion', (p: ReturnType<typeof cpu>) => { cpuCase(p).status = 'skipped'; }],
  ['todo assertion', (p: ReturnType<typeof cpu>) => { cpuCase(p).status = 'todo'; }],
  ['failure message after passing status', (p: ReturnType<typeof cpu>) => { (cpuCase(p).failureMessages as string[]).push('failure'); }],
  ['failed file with passing leaves', (p: ReturnType<typeof cpu>) => { p.report.testResults[0]!.status = 'failed'; }],
  ['file-level execution message', (p: ReturnType<typeof cpu>) => { p.report.testResults[0]!.message = 'hook failed'; }],
  ['changed fullName', (p: ReturnType<typeof cpu>) => { cpuCase(p).fullName = 'different'; }],
  ['hierarchy alias', (p: ReturnType<typeof cpu>) => { cpuCase(p).ancestorTitles = ['different', 'inner']; }],
  ['reported leaf count', (p: ReturnType<typeof cpu>) => { p.report.numTotalTests = 2; }],
  ['reported suite count', (p: ReturnType<typeof cpu>) => { p.report.numTotalTestSuites = 4; }],
  ['pending suite count', (p: ReturnType<typeof cpu>) => { p.report.numPendingTestSuites = 1; }],
  ['extra file suite', (p: ReturnType<typeof cpu>) => { p.report.testResults.push(structuredClone(p.report.testResults[0]!)); }],
  ['missing expected assertion', (p: ReturnType<typeof cpu>) => { p.report.testResults[0]!.assertionResults = []; }],
  ['unbound file path', (p: ReturnType<typeof cpu>) => { p.report.testResults[0]!.name = 'C:/repo/tests/other.test.ts'; }],
  ['external file path', (p: ReturnType<typeof cpu>) => { p.report.testResults[0]!.name = 'C:/elsewhere/test.ts'; }],
  ['explicit retry metadata', (p: ReturnType<typeof cpu>) => { cpuCase(p).meta = { retryCount: 1 }; }],
  ['explicit repeat metadata', (p: ReturnType<typeof cpu>) => { cpuCase(p).meta = { repeatCount: 1 }; }],
  ['real retry diagnostics', (p: ReturnType<typeof cpu>) => { cpuCase(p).releaseDiagnostics.retryCount = 1; }],
  ['real repeat diagnostics', (p: ReturnType<typeof cpu>) => { cpuCase(p).releaseDiagnostics.repeatCount = 1; }],
] as const) test(`release Vitest report rejects ${name}`, async () => {
  const packet = cpu(); change(packet);
  assert.equal((await inspectTestReport('vitest', packet.report, packet.wanted, context())).valid, false);
});
for (const [name, change] of [
  ['unexpected failures', (p: Browser) => { p.report.stats.unexpected = 1; }],
  ['skipped count', (p: Browser) => { p.report.stats.skipped = 1; }],
  ['flaky count', (p: Browser) => { p.report.stats.flaky = 1; }],
  ['false spec okay flag', (p: Browser) => { spec(p).ok = false; }],
  ['expected failure', (p: Browser) => { spec(p).tests[0]!.expectedStatus = 'failed'; }],
  ['skipped result', (p: Browser) => { result(p).status = 'skipped'; }],
  ['positive retry', (p: Browser) => { result(p).retry = 1; }],
  ['multiple results', (p: Browser) => { spec(p).tests[0]!.results.push(structuredClone(result(p))); }],
  ['empty results', (p: Browser) => { spec(p).tests[0]!.results = []; }],
  ['wrong title', (p: Browser) => { spec(p).title = 'foreign title'; }],
  ['wrong case ID', (p: Browser) => { spec(p).id = 'foreign-id'; }],
  ['wrong file', (p: Browser) => { spec(p).file = 'b.spec.ts'; }],
  ['duplicate test', (p: Browser) => { spec(p).tests.push(structuredClone(spec(p).tests[0]!)); }],
  ['wrong project', (p: Browser) => { spec(p).tests[0]!.projectName = 'foreign-project'; }],
  ['wrong output directory', (p: Browser) => { p.report.config.projects[0]!.outputDir = 'C:/repo/.build/foreign'; }],
  ['foreign filtered project', (p: Browser) => { p.report.config.filteredProjects[0]!.name = 'unused-configuration'; }],
  ['unbound empty suite', (p: Browser) => { p.report.suites.push({ title: 'foreign.spec.ts', file: 'foreign.spec.ts', specs: [] }); }],
] as const) test(`release Playwright report rejects ${name}`, async () => {
  const packet = browser(); change(packet);
  assert.equal((await inspectTestReport('playwright', packet.report, packet.wanted, context())).valid, false);
});
test('release reports reject top-level errors and skipped suites despite green leaves', async () => {
  const p = browser();
  const errors = { ...p.report, errors: [{ message: 'teardown failure' }] };
  assert.equal((await inspectTestReport('playwright', errors, p.wanted, context())).valid, false);
  const skipped = { ...p.report, suites: [{ ...p.report.suites[0], skipped: true }] };
  assert.equal((await inspectTestReport('playwright', skipped, p.wanted, context())).valid, false);
});
test('release report adapters require complete reporters rather than a passing last-run summary', async () => {
  for (const kind of ['vitest', 'playwright'] as const) {
    const wanted = kind === 'vitest' ? cpu().wanted : browser().wanted;
    assert.equal((await inspectTestReport(kind, { status: 'passed', failedTests: [] }, wanted, context())).valid, false);
  }
});
test('release reports pin duplicate source/leaf inventory and adapter identity', async () => {
  const p = cpu(); p.wanted.files.push(structuredClone(p.wanted.files[0]!));
  assert.equal((await inspectTestReport('vitest', p.report, p.wanted, context())).valid, false);
  const b = browser(); b.wanted.adapter = 'vitest';
  assert.equal((await inspectTestReport('playwright', b.report, b.wanted, context())).valid, false);
});
test('release adapter hashes canonical inline attachment bytes without inventing a workspace FileRef', async () => {
  const p = browser(), content = bytes({ owner: 'synthetic' });
  result(p).attachments.push({ name: 'proof', contentType: 'application/json', body: Buffer.from(content).toString('base64') });
  p.wanted.requiredAttachments = [{ caseId: 'case-a', project: '', name: 'proof', sha256: digest(content), fixtureSetId: null }];
  const observed = await inspectTestReport('playwright', p.report, p.wanted, context());
  assert.equal(observed.valid, true, JSON.stringify(observed.issues));
  assert.deepEqual(observed.leaves[0]!.attachments, [{ name: 'proof', contentType: 'application/json', bytes: content.byteLength, sha256: digest(content), path: null }]);
});
for (const body of ['not base64!', 'YQ', 'YQ=\n', 'YR==', 'YWI===']) test(`release inline attachment rejects noncanonical base64 ${JSON.stringify(body)}`, async () => {
  const p = browser(); result(p).attachments.push({ name: 'proof', contentType: 'application/json', body });
  assert.equal((await inspectTestReport('playwright', p.report, p.wanted, context())).valid, false);
});
test('release file attachments bind actual bytes and the independently pinned output inventory', async () => {
  const p = browser(), path = '.build/policy/output/proof.bin', content = new Uint8Array([0, 1, 254, 255]);
  result(p).attachments.push({ name: 'proof', contentType: 'application/octet-stream', path: `C:/repo/${path}` });
  p.wanted.outputFiles = [ref(path, content)];
  const ctx = context(new Map([[path, content]]));
  assert.equal((await inspectTestReport('playwright', p.report, p.wanted, ctx)).valid, true);
  p.wanted.outputFiles[0]!.sha256 = H('f');
  assert.equal((await inspectTestReport('playwright', p.report, p.wanted, ctx)).valid, false);
});
test('release file attachments reject missing output membership, forged reads and outside paths', async () => {
  const p = browser(), path = '.build/policy/output/proof.bin', content = new Uint8Array([2]);
  result(p).attachments.push({ name: 'proof', contentType: 'application/octet-stream', path });
  const ctx = context(new Map([[path, content]]));
  assert.equal((await inspectTestReport('playwright', p.report, p.wanted, ctx)).valid, false);
  p.wanted.outputFiles = [ref(path, content)];
  const forged = { ...ctx, readAttachment: async () => ({ reference: ref(path, content), bytes: new Uint8Array([3]) }) };
  assert.equal((await inspectTestReport('playwright', p.report, p.wanted, forged)).valid, false);
  result(p).attachments[0] = { name: 'proof', contentType: 'text/plain', path: 'C:/outside/proof.bin' };
  assert.equal((await inspectTestReport('playwright', p.report, p.wanted, ctx)).valid, false);
});
test('release attachment requires exactly one path or inline body', async () => {
  const p = browser(); result(p).attachments.push({ name: 'proof', contentType: 'text/plain', path: '.build/policy/output/proof.txt', body: 'YQ==' });
  assert.equal((await inspectTestReport('playwright', p.report, p.wanted, context())).valid, false);
  result(p).attachments[0] = { name: 'proof', contentType: 'text/plain' };
  assert.equal((await inspectTestReport('playwright', p.report, p.wanted, context())).valid, false);
});
test('release required attachments reject absence, duplicates, hash changes and foreign case requirements', async () => {
  const p = browser(); p.wanted.requiredAttachments = [{ caseId: 'case-a', project: '', name: 'proof', sha256: H('a'), fixtureSetId: null }];
  assert.equal((await inspectTestReport('playwright', p.report, p.wanted, context())).valid, false);
  result(p).attachments.push({ name: 'proof', contentType: 'text/plain', body: 'YQ==' });
  assert.equal((await inspectTestReport('playwright', p.report, p.wanted, context())).valid, false);
  p.wanted.requiredAttachments[0]!.sha256 = null;
  assert.equal((await inspectTestReport('playwright', p.report, p.wanted, context())).valid, true);
  result(p).attachments.push(structuredClone(result(p).attachments[0]));
  assert.equal((await inspectTestReport('playwright', p.report, p.wanted, context())).valid, false);
  result(p).attachments.pop(); p.wanted.requiredAttachments[0]!.caseId = 'foreign-case';
  assert.equal((await inspectTestReport('playwright', p.report, p.wanted, context())).valid, false);
});
function fixturePacket() {
  const p = browser();
  const fixture = { fixtureSetId: H('f'), fixtures: { A: { deploymentId: H('a') }, B: { deploymentId: H('b') }, C: { deploymentId: H('c') } },
    sourceCapture: { initial: { inventory: [ref('src/main.tsx')] }, final: { inventory: [ref('src/main.tsx')] } },
    shippingNativePublication: [ref('public/wasm/splatview-core.wasm')] };
  const reference = ref('.build/genuine/fixture-set.json', bytes(fixture));
  const attached = { fixtureSetId: fixture.fixtureSetId, fixtures: structuredClone(fixture.fixtures), sourceCapture: structuredClone(fixture.sourceCapture),
    shippingNativePublication: structuredClone(fixture.shippingNativePublication), receipt: reference };
  const ctx = { ...context(), fixtureSet: { reference, value: fixture } };
  p.wanted.requiredAttachments = [{ caseId: 'case-a', project: '', name: 'genuine-fixture-inputs', sha256: null, fixtureSetId: fixture.fixtureSetId }];
  const sync = (): void => { result(p).attachments = [{ name: 'genuine-fixture-inputs', contentType: 'application/json', body: Buffer.from(bytes(attached)).toString('base64') }]; };
  sync();
  return { p, attached, ctx, sync };
}
test('release genuine-fixture attachment binds receipt identity and the complete cohort/source/native metadata', async () => {
  const f = fixturePacket(), observed = await inspectTestReport('playwright', f.p.report, f.p.wanted, f.ctx);
  assert.equal(observed.valid, true, JSON.stringify(observed.issues));
});
for (const [name, change] of [
  ['fixture set ID', (f: ReturnType<typeof fixturePacket>) => { f.attached.fixtureSetId = H('d'); }],
  ['receipt path', (f: ReturnType<typeof fixturePacket>) => { f.attached.receipt = { ...f.attached.receipt, path: '.build/foreign/fixture-set.json' }; }],
  ['receipt byte count', (f: ReturnType<typeof fixturePacket>) => { f.attached.receipt = { ...f.attached.receipt, bytes: 1 }; }],
  ['receipt hash', (f: ReturnType<typeof fixturePacket>) => { f.attached.receipt = { ...f.attached.receipt, sha256: H('d') }; }],
  ['cohort deployment', (f: ReturnType<typeof fixturePacket>) => { f.attached.fixtures.A.deploymentId = H('d'); }],
  ['source capture', (f: ReturnType<typeof fixturePacket>) => { f.attached.sourceCapture.initial.inventory[0]!.sha256 = H('d'); }],
  ['native publication', (f: ReturnType<typeof fixturePacket>) => { f.attached.shippingNativePublication[0]!.bytes = 77; }],
] as const) test(`release genuine-fixture attachment rejects changed ${name}`, async () => {
  const f = fixturePacket(); change(f); f.sync();
  assert.equal((await inspectTestReport('playwright', f.p.report, f.p.wanted, f.ctx)).valid, false);
});
test('release fixture requirement refuses missing context and non-JSON proof bytes', async () => {
  const f = fixturePacket();
  assert.equal((await inspectTestReport('playwright', f.p.report, f.p.wanted, context())).valid, false);
  result(f.p).attachments = [{ name: 'genuine-fixture-inputs', contentType: 'application/json', body: Buffer.from('not json').toString('base64') }];
  assert.equal((await inspectTestReport('playwright', f.p.report, f.p.wanted, f.ctx)).valid, false);
});
test('release inspection does not mutate frozen report, inventory or fixture context', async () => {
  const f = fixturePacket();
  const freeze = (value: unknown): void => { if (value !== null && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } };
  freeze(f.p); freeze(f.ctx.fixtureSet);
  const before = JSON.stringify({ packet: f.p, fixture: f.ctx.fixtureSet });
  assert.equal((await inspectTestReport('playwright', f.p.report, f.p.wanted, f.ctx)).valid, true);
  assert.equal(JSON.stringify({ packet: f.p, fixture: f.ctx.fixtureSet }), before);
});
